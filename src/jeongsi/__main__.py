"""실행 진입점.

  jeongsi                 Windows: 창 + 트레이로 실행
  jeongsi --dev           어디서나: 가짜 오디오로 서버만 실행(브라우저로 http://127.0.0.1:48650 접속)
  jeongsi --autostart     Windows 로그인 시 자동 실행(설정에 따라 창 없이 트레이로)
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
import urllib.request
from pathlib import Path

from . import APP_ID
from .bootstrap import build_application, default_data_dir, setup_logging

log = logging.getLogger(__name__)
DEFAULT_PORT = 48650


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="jeongsi", description="정시 방송")
    parser.add_argument("--dev", action="store_true", help="가짜 오디오로 서버만 실행")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--data-dir", type=Path, help="데이터 폴더(기본: %%APPDATA%%\\JeongsiBroadcast)")
    parser.add_argument("--autostart", action="store_true", help="로그인 시 자동 실행됨")
    parser.add_argument("--updated", action="store_true", help="업데이트 직후 실행됨")
    return parser.parse_args(argv)


def ping_existing(port: int) -> str:
    """'ours': 이미 이 앱이 실행 중, 'other': 다른 프로그램이 포트 사용 중, 'free': 비어 있음."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=1.5) as resp:  # noqa: S310
            data = json.loads(resp.read().decode("utf-8"))
        return "ours" if data.get("app") == APP_ID else "other"
    except (OSError, ValueError):
        import socket

        with socket.socket() as sock:
            return "other" if sock.connect_ex(("127.0.0.1", port)) == 0 else "free"


def show_existing_window(port: int) -> None:
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/window/show", method="POST", data=b"{}", headers={"X-Jeongsi-Client": "1", "Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=2)  # noqa: S310
    except OSError:
        log.warning("이미 실행 중인 앱의 창을 열지 못했습니다")


def run_headless(args: argparse.Namespace, data_dir: Path) -> int:
    import uvicorn

    from .app import NullShell, create_app

    application = build_application(data_dir, args.port, NullShell(), use_fake_audio=args.dev)
    application.start()
    print(f"정시 방송: http://127.0.0.1:{args.port}  (데이터: {data_dir})", flush=True)
    try:
        uvicorn.run(create_app(application.services), host="127.0.0.1", port=args.port, log_level="warning")
    finally:
        application.stop()
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    data_dir = args.data_dir or default_data_dir()
    setup_logging(data_dir, verbose=args.dev)

    state = ping_existing(args.port)
    if args.updated:
        # 업데이트 직후에는 이전 버전이 끝날 때까지 기다린다
        deadline = time.monotonic() + 20
        while state != "free" and time.monotonic() < deadline:
            time.sleep(0.5)
            state = ping_existing(args.port)
    if state == "ours":
        if not args.autostart:
            show_existing_window(args.port)
        return 0
    if state == "other":
        message = f"다른 프로그램이 포트 {args.port}을(를) 쓰고 있어 정시 방송을 시작할 수 없습니다."
        log.error(message)
        if sys.platform == "win32" and not args.dev:
            import ctypes

            ctypes.windll.user32.MessageBoxW(None, message, "정시 방송", 0x10)
        return 1

    if args.dev or sys.platform != "win32":
        return run_headless(args, data_dir)
    from .desktop import run_desktop

    return run_desktop(args, data_dir)


if __name__ == "__main__":
    sys.exit(main())
