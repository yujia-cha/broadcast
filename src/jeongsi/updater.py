"""GitHub 릴리즈로 새 버전을 확인하고 적용한다.

적용 방법: Windows는 실행 중인 exe를 지울 수는 없지만 이름은 바꿀 수 있다.
  현재 exe → <이름>.old.exe, 새 exe → 원래 이름, 새 exe 실행 후 현재 앱 종료.
새 버전이 시작되면 .old.exe를 지운다. 새 버전이 뜨지 않으면 .old.exe 이름을 되돌려 복구할 수 있다.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path

from . import APP_ID, GITHUB_REPO

log = logging.getLogger(__name__)

ASSET_NAME = f"{APP_ID}.exe"
# 배포 테스트 전용: 로컬 가짜 릴리즈 주소(http://127.0.0.1:...만 허용). 사용자 PC에서는 쓰지 않는다.
FEED_ENV = "JEONGSI_UPDATE_FEED"
LOCAL_FEED_PREFIX = "http://127.0.0.1:"
CHECKSUM_SUFFIX = ".sha256"
USER_AGENT = f"{APP_ID}-updater"
CHUNK = 64 * 1024
MAX_DOWNLOAD = 300 * 1024 * 1024


class UpdateError(Exception):
    pass


@dataclass(frozen=True)
class ReleaseInfo:
    version: str
    notes: str
    published_at: str
    html_url: str
    asset_url: str
    checksum_url: str


def parse_version(text: str) -> tuple[int, ...] | None:
    """'v1.2.0' → (1, 2, 0). 사전 릴리즈('-beta')나 잘못된 형식은 None."""
    text = text.strip().lstrip("vV")
    if not text or "-" in text or "+" in text:
        return None
    try:
        parts = tuple(int(p) for p in text.split("."))
    except ValueError:
        return None
    return parts if all(p >= 0 for p in parts) else None


def is_newer(candidate: str, current: str) -> bool:
    new, cur = parse_version(candidate), parse_version(current)
    if new is None or cur is None:
        return False
    width = max(len(new), len(cur))
    return new + (0,) * (width - len(new)) > cur + (0,) * (width - len(cur))


def _open(url: str, timeout: float = 15.0):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"})
    return urllib.request.urlopen(request, timeout=timeout)  # noqa: S310 (https 고정 주소)


class Updater:
    def __init__(
        self,
        current_version: str,
        repo: str = GITHUB_REPO,
        opener: Callable[[str], object] = _open,
        on_change: Callable[[], None] | None = None,
        feed_url: str | None = None,
    ):
        if feed_url is not None and not feed_url.startswith(LOCAL_FEED_PREFIX):
            raise ValueError("테스트용 업데이트 주소는 http://127.0.0.1만 허용합니다.")
        self.current_version = current_version
        self._repo = repo
        self._feed_url = feed_url or f"https://api.github.com/repos/{repo}/releases/latest"
        self._download_prefix = LOCAL_FEED_PREFIX if feed_url else "https://github.com/"
        self._open = opener
        self._on_change = on_change or (lambda: None)
        self._lock = threading.Lock()
        self._state: dict = {"state": "idle"}
        self._release: ReleaseInfo | None = None

    # 상태 ------------------------------------------------------------------
    def status(self) -> dict:
        with self._lock:
            snap = dict(self._state)
            if self._release:
                snap["release"] = asdict(self._release)
        snap["current"] = self.current_version
        return snap

    def mark_error(self, message: str) -> None:
        self._set(state="error", message=message)

    def _set(self, **values) -> None:
        with self._lock:
            self._state = values
        self._on_change()

    # 확인 ------------------------------------------------------------------
    def check(self) -> ReleaseInfo | None:
        """최신 정식 릴리즈가 현재보다 새 버전이면 돌려준다. 네트워크 오류는 UpdateError."""
        self._set(state="checking")
        try:
            with self._open(self._feed_url) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:  # 아직 릴리즈가 없음
                self._release = None
                self._set(state="latest")
                return None
            self._set(state="error", message="업데이트 서버에 연결하지 못했습니다.")
            raise UpdateError(f"업데이트 확인 실패: HTTP {exc.code}") from exc
        except (OSError, ValueError) as exc:
            self._set(state="error", message="업데이트 서버에 연결하지 못했습니다.")
            raise UpdateError(f"업데이트 확인 실패: {exc}") from exc

        release = self._parse_release(data)
        self._release = release
        self._set(state="available" if release else "latest")
        return release

    def _parse_release(self, data: dict) -> ReleaseInfo | None:
        if data.get("draft") or data.get("prerelease"):
            return None
        tag = str(data.get("tag_name", ""))
        if not is_newer(tag, self.current_version):
            return None
        assets = {a.get("name"): a.get("browser_download_url") for a in data.get("assets", [])}
        asset_url, checksum_url = assets.get(ASSET_NAME), assets.get(ASSET_NAME + CHECKSUM_SUFFIX)
        if not asset_url or not checksum_url:
            log.warning("릴리즈 %s에 %s 또는 체크섬 파일이 없습니다", tag, ASSET_NAME)
            return None
        for url in (asset_url, checksum_url):
            if not url.startswith(self._download_prefix):
                log.warning("허용하지 않는 다운로드 주소: %s", url)
                return None
        return ReleaseInfo(
            version=tag.lstrip("vV"),
            notes=str(data.get("body") or "")[:4000],
            published_at=str(data.get("published_at") or ""),
            html_url=str(data.get("html_url") or f"https://github.com/{self._repo}/releases"),
            asset_url=asset_url,
            checksum_url=checksum_url,
        )

    # 다운로드 ----------------------------------------------------------------
    def download(self, release: ReleaseInfo, dest_dir: Path) -> Path:
        """새 exe를 받아 SHA-256을 검증한다. 실패하면 임시 파일을 지우고 UpdateError."""
        dest_dir.mkdir(parents=True, exist_ok=True)
        target = dest_dir / f"{APP_ID}.new.exe"
        partial = target.with_suffix(".part")
        try:
            expected = self._read_checksum(release.checksum_url)
            digest = hashlib.sha256()
            with self._open(release.asset_url) as resp, open(partial, "wb") as out:
                total = int(getattr(resp, "headers", {}).get("Content-Length") or 0)
                received = 0
                while chunk := resp.read(CHUNK):
                    received += len(chunk)
                    if received > MAX_DOWNLOAD:
                        raise UpdateError("업데이트 파일이 너무 큽니다.")
                    digest.update(chunk)
                    out.write(chunk)
                    self._set(state="downloading", progress=round(received / total, 3) if total else None)
            if digest.hexdigest().lower() != expected:
                raise UpdateError("받은 파일이 손상되었습니다(체크섬 불일치). 다시 시도하세요.")
            os.replace(partial, target)
        except UpdateError as exc:
            partial.unlink(missing_ok=True)
            self._set(state="error", message=str(exc))
            raise
        except PermissionError as exc:
            partial.unlink(missing_ok=True)
            message = "이 폴더에는 업데이트를 쓸 수 없습니다. 릴리즈 페이지에서 새 버전을 직접 받아 주세요."
            self._set(state="error", message=message)
            raise UpdateError(message) from exc
        except OSError as exc:
            partial.unlink(missing_ok=True)
            self._set(state="error", message="업데이트 파일을 받지 못했습니다.")
            raise UpdateError(f"다운로드 실패: {exc}") from exc
        self._set(state="ready")
        return target

    def _read_checksum(self, url: str) -> str:
        with self._open(url) as resp:
            text = resp.read(4096).decode("utf-8", "replace").strip()
        value = text.split()[0].lower() if text else ""
        if len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
            raise UpdateError("체크섬 파일 형식이 올바르지 않습니다.")
        return value


# 적용 ------------------------------------------------------------------------
def old_exe_path(exe_path: Path) -> Path:
    return exe_path.with_name(exe_path.stem + ".old" + exe_path.suffix)


def _launch_detached(args: list[str]) -> None:
    """이전 앱이 끝나도 새 앱이 같이 끝나지 않도록 분리해서 실행한다."""
    flags = 0
    if sys.platform == "win32":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        try:
            subprocess.Popen(args, close_fds=True, creationflags=flags | 0x01000000)  # CREATE_BREAKAWAY_FROM_JOB  # noqa: S603
            return
        except OSError:
            log.info("작업 그룹에서 분리할 수 없어 일반 방식으로 실행합니다")
    subprocess.Popen(args, close_fds=True, creationflags=flags)  # noqa: S603


def apply_update(
    new_file: Path,
    exe_path: Path,
    launch: Callable[[list[str]], None] | None = None,
    extra_args: list[str] | None = None,
) -> None:
    """exe를 교체하고 새 exe를 실행한다. 교체에 실패하면 원래 exe를 되돌린다."""
    launch = launch or _launch_detached
    old = old_exe_path(exe_path)
    try:
        old.unlink(missing_ok=True)
        os.replace(exe_path, old)
    except OSError as exc:
        raise UpdateError(
            "이 폴더에는 업데이트를 쓸 수 없습니다. 릴리즈 페이지에서 새 버전을 직접 받아 주세요."
        ) from exc
    try:
        os.replace(new_file, exe_path)
    except OSError as exc:
        os.replace(old, exe_path)
        raise UpdateError(f"새 버전으로 바꾸지 못했습니다: {exc}") from exc
    launch([str(exe_path), *(extra_args or []), "--updated"])


def cleanup_old_exe(exe_path: Path, attempts: int = 20, delay: float = 0.5) -> None:
    """이전 버전 exe를 지운다. 이전 앱이 막 끝나는 중이면 잠시 잠겨 있을 수 있어 몇 번 다시 시도한다."""
    import time

    old = old_exe_path(exe_path)
    for _ in range(attempts):
        try:
            old.unlink(missing_ok=True)
            return
        except OSError:
            time.sleep(delay)
    log.info("이전 버전 파일을 아직 지울 수 없습니다. 다음 실행 때 다시 지웁니다")
