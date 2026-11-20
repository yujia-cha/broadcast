"""빌드한 exe 배포 스모크 테스트(Windows 러너용).

  python tools/smoke_exe.py dist/JeongsiBroadcast.exe

확인하는 것
  1. 개발 모드(--dev): exe 안의 화면 파일·글꼴이 서비스되고, 가짜 오디오로 방송이 끝까지 된다
  2. 실제 모드: Windows 오디오 백엔드로 방송을 실행한다(재생 장치가 없으면 장치 오류만 허용),
     로그인 자동 실행 레지스트리 등록·해제, 음성 목록
  3. 업데이트: 로컬 가짜 릴리즈 서버로 확인 → 받기·검증 → exe 교체 → 새 exe가 같은 포트로 다시 뜨고
     이전 exe 파일을 지운다
"""

from __future__ import annotations

import hashlib
import http.server
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

HEADERS = {"X-Jeongsi-Client": "1", "Content-Type": "application/json"}
EXE_NAME = "JeongsiBroadcast.exe"
results: list[tuple[str, bool, str]] = []


def call(port: int, method: str, path: str, body: dict | None = None, timeout: float = 10):
    data = json.dumps(body).encode() if body is not None else (b"{}" if method != "GET" else None)
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        ctype = resp.headers.get("Content-Type", "")
        return json.loads(raw) if "json" in ctype and raw else raw


def wait_for(predicate, timeout: float, interval: float = 0.5):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            value = predicate()
            if value:
                return value
        except (OSError, ValueError) as exc:
            last_error = exc
        time.sleep(interval)
    raise TimeoutError(f"시간 초과 (마지막 오류: {last_error!r})")


def ping(port: int) -> bool:
    return call(port, "GET", "/api/ping", timeout=2).get("app") == "JeongsiBroadcast"


def kill_tree(proc: subprocess.Popen | None) -> None:
    if proc and proc.poll() is None:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        proc.wait(15)


def check(name: str, fn) -> None:
    print(f"\n== {name}", flush=True)
    try:
        detail = fn() or ""
        results.append((name, True, str(detail)))
        print(f"   통과 {detail}", flush=True)
    except Exception as exc:  # 다음 검사를 계속한다
        results.append((name, False, repr(exc)))
        print(f"   실패: {exc!r}", flush=True)


def broadcast_once(port: int, text: str) -> dict:
    program = call(port, "POST", "/api/programs", {"name": "스모크", "steps": [{"kind": "tts", "text": text}]})
    call(port, "POST", "/api/broadcast", {"program_id": program["id"]})
    # 방송 기록은 남기지 않으므로 상태의 마지막 결과(메모리)로 확인한다
    return wait_for(lambda: call(port, "GET", "/api/status")["runner"].get("last"), timeout=90)


def dump_log(data_dir: Path) -> None:
    log = data_dir / "logs" / "app.log"
    if log.exists():
        print("---- app.log (끝부분) ----")
        print("\n".join(log.read_text(encoding="utf-8", errors="replace").splitlines()[-40:]))


# 1. 개발 모드 ----------------------------------------------------------------------
def dev_mode(exe: Path, work: Path) -> str:
    port, data = 48661, work / "dev-data"
    proc = subprocess.Popen([str(exe), "--dev", "--port", str(port), "--data-dir", str(data)])
    try:
        wait_for(lambda: ping(port), timeout=90)
        index = call(port, "GET", "/").decode("utf-8")
        assert "정시 방송" in index, "화면 HTML이 아닙니다"
        for path in ("/static/app.js", "/static/views/timetable.js", "/static/fonts/Pretendard-Regular.woff2"):
            assert len(call(port, "GET", path)) > 100, f"{path} 비어 있음"
        entry = broadcast_once(port, "개발 모드 시험")
        assert entry["result"] == "done", entry
        return f"방송 결과 {entry['result']}"
    finally:
        kill_tree(proc)
        dump_log(data)


# 2. 실제 모드 ----------------------------------------------------------------------
def run_key_value() -> str | None:
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
            return winreg.QueryValueEx(key, "JeongsiBroadcast")[0]
    except FileNotFoundError:
        return None


def real_mode(exe: Path, work: Path) -> str:
    port, data = 48662, work / "real-data"
    proc = subprocess.Popen([str(exe), "--port", str(port), "--data-dir", str(data)])
    try:
        wait_for(lambda: ping(port), timeout=90)
        status = call(port, "GET", "/api/status")
        assert status["can_update"] is True, "exe인데 업데이트할 수 없다고 나옵니다"
        voices = call(port, "GET", "/api/voices")
        assert voices, "음성 목록이 비어 있습니다"
        value = wait_for(run_key_value, timeout=10)
        assert str(exe) in value and "--autostart" in value, value
        call(port, "PATCH", "/api/settings", {"autostart": False})
        assert run_key_value() is None, "자동 실행 해제가 레지스트리에 반영되지 않았습니다"
        entry = broadcast_once(port, "This is a smoke test broadcast.")
        assert not (data / "work" / "restore.json").exists(), "복원 파일이 남았습니다"
        if entry["result"] != "done":
            assert "device" in entry["error"].lower(), f"장치 문제가 아닌 실패: {entry}"
        return f"음성 {len(voices)}개, 방송 결과 {entry['result']} {entry['error']}".strip()
    finally:
        kill_tree(proc)
        dump_log(data)


# 3. 업데이트 ----------------------------------------------------------------------
class FeedHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def update_flow(exe: Path, work: Path) -> str:
    port, data = 48663, work / "update-data"
    install = work / "install"
    install.mkdir()
    installed = install / EXE_NAME
    shutil.copy2(exe, installed)

    feed_dir = work / "feed"
    feed_dir.mkdir()
    shutil.copy2(exe, feed_dir / EXE_NAME)
    digest = hashlib.sha256((feed_dir / EXE_NAME).read_bytes()).hexdigest()
    (feed_dir / f"{EXE_NAME}.sha256").write_text(f"{digest}  {EXE_NAME}", encoding="ascii")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), lambda *a: FeedHandler(*a, directory=str(feed_dir)))
    feed_port = server.server_address[1]
    base = f"http://127.0.0.1:{feed_port}"
    (feed_dir / "latest.json").write_text(json.dumps({
        "tag_name": "v99.0.0", "body": "스모크 테스트", "published_at": "2026-01-01T00:00:00Z", "html_url": base,
        "assets": [
            {"name": EXE_NAME, "browser_download_url": f"{base}/{EXE_NAME}"},
            {"name": f"{EXE_NAME}.sha256", "browser_download_url": f"{base}/{EXE_NAME}.sha256"},
        ],
    }), encoding="utf-8")
    threading.Thread(target=server.serve_forever, daemon=True).start()

    env = {**__import__("os").environ, "JEONGSI_UPDATE_FEED": f"{base}/latest.json"}
    proc = subprocess.Popen([str(installed), "--port", str(port), "--data-dir", str(data)], env=env)
    try:
        wait_for(lambda: ping(port), timeout=90)
        status = call(port, "POST", "/api/update/check")
        assert status.get("release", {}).get("version") == "99.0.0", status
        call(port, "POST", "/api/update/apply")
        proc.wait(90)  # 이전 버전이 스스로 끝나야 한다
        wait_for(lambda: ping(port), timeout=120)  # 새 버전이 같은 포트로 다시 뜬다
        old = install / "JeongsiBroadcast.old.exe"
        wait_for(lambda: not old.exists(), timeout=60)
        leftovers = sorted(p.name for p in install.iterdir())
        assert leftovers == [EXE_NAME], f"설치 폴더에 남은 파일: {leftovers}"
        assert hashlib.sha256(installed.read_bytes()).hexdigest() == digest
        return "교체·재시작·이전 파일 정리 확인"
    finally:
        kill_tree(proc)
        subprocess.run(["taskkill", "/IM", EXE_NAME, "/F"], capture_output=True)
        server.shutdown()
        dump_log(data)


def main() -> int:
    for stream in (sys.stdout, sys.stderr):  # Windows 콘솔 기본 인코딩(cp1252)은 한글을 못 쓴다
        stream.reconfigure(encoding="utf-8", errors="replace")
    exe = Path(sys.argv[1]).resolve()
    assert exe.exists(), exe
    print(f"exe: {exe} ({exe.stat().st_size / 1024 / 1024:.1f} MB)")
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        work = Path(tmp)
        check("개발 모드 실행·화면 파일·방송", lambda: dev_mode(exe, work))
        check("실제 모드 실행·자동 실행 등록·Windows 오디오 방송", lambda: real_mode(exe, work))
        check("업데이트 받기·교체·재시작", lambda: update_flow(exe, work))
        subprocess.run(["taskkill", "/IM", EXE_NAME, "/F"], capture_output=True)
        time.sleep(2)
    print("\n== 요약")
    for name, ok, detail in results:
        print(f"{'통과' if ok else '실패'} | {name} | {detail}")
    return 0 if all(ok for _, ok, _ in results) else 1


if __name__ == "__main__":
    sys.exit(main())
