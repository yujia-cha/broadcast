"""화면 E2E 실행기: 빈 데이터 폴더로 개발 서버를 띄우고 ui_flow.cjs를 돌린다.

사용: python tests/e2e/run_e2e.py [스크린샷 폴더]
필요: Node.js와 playwright(npm), Chromium
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
import urllib.request
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PORT = 48765


def make_wav(path: Path, seconds: float) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"\x00\x00" * int(8000 * seconds))


def wait_ready(url: str, timeout: float = 30) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1):
                return
        except OSError:
            time.sleep(0.3)
    raise RuntimeError("서버가 시작되지 않았습니다")


def main() -> int:
    out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "e2e-screenshots").resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        assets = tmp_path / "assets"
        assets.mkdir()
        make_wav(assets / "chime.wav", 2)
        env = {**os.environ, "PYTHONPATH": str(ROOT / "src")}
        server = subprocess.Popen(
            [sys.executable, "-m", "jeongsi", "--dev", "--port", str(PORT), "--data-dir", str(tmp_path / "data")],
            env=env,
        )
        try:
            wait_ready(f"http://127.0.0.1:{PORT}/api/ping")
            result = subprocess.run(
                ["node", str(ROOT / "tests" / "e2e" / "ui_flow.cjs"), f"http://127.0.0.1:{PORT}/", str(out_dir), str(assets)],
                cwd=ROOT,
            )
            return result.returncode
        finally:
            server.terminate()
            server.wait(10)


if __name__ == "__main__":
    sys.exit(main())
