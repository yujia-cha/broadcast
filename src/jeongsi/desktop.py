"""Windows 데스크톱 셸: 앱 창(WebView2), 트레이 아이콘, 자동 실행, 창 닫기 → 트레이.

WebView2가 없는 PC에서는 기본 브라우저로 화면을 연다.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import webbrowser
from pathlib import Path

from . import APP_NAME, autostart
from .app import create_app
from .bootstrap import Application, build_application
from .icon import ORANGE, TEAL, app_icon
from .updater import cleanup_old_exe

log = logging.getLogger(__name__)


class DesktopShell:
    def __init__(self, url: str):
        self.url = url
        self.window = None
        self.icon = None
        self.application: Application | None = None
        self.quitting = False
        self.browser_mode = False
        self._browser_exit = threading.Event()

    # Shell 인터페이스 ---------------------------------------------------------
    def show_window(self) -> None:
        if self.window is not None:
            self.window.show()
            self.window.restore()
        else:
            webbrowser.open(self.url)

    def open_folder(self, path: Path) -> None:
        os.startfile(str(path))  # noqa: S606 (사용자 데이터 폴더)

    def set_autostart(self, enabled: bool) -> None:
        autostart.set_enabled(enabled)

    def exe_path(self) -> Path | None:
        return Path(sys.executable) if getattr(sys, "frozen", False) else None

    def request_exit(self) -> None:
        self.quit()

    # 동작 ------------------------------------------------------------------
    def quit(self) -> None:
        self.quitting = True
        if self.icon is not None:
            self.icon.stop()
        if self.window is not None:
            self.window.destroy()
        elif self.application is not None:
            self._browser_exit.set()

    def on_closing(self) -> bool:
        """창 닫기: 설정에 따라 트레이로 숨기거나 종료. False를 돌려주면 닫기를 취소한다."""
        if self.quitting:
            return True
        settings = self.application.services.store.config.settings
        if settings.close_to_tray:
            self.window.hide()
            return False
        self.quitting = True
        if self.icon is not None:
            self.icon.stop()
        return True

    def start_tray(self) -> None:
        import pystray

        services = self.application.services

        def on_air(_item=None) -> bool:
            return services.runner.on_air

        def auto_on(_item=None) -> bool:
            return services.store.config.settings.auto_broadcast

        def toggle_auto(_icon, _item) -> None:
            services.store.update(lambda c: setattr(c.settings, "auto_broadcast", not c.settings.auto_broadcast))

        menu = pystray.Menu(
            pystray.MenuItem("열기", lambda: self.show_window(), default=True),
            pystray.MenuItem("방송 끄기", lambda: services.runner.stop_current(), enabled=on_air),
            pystray.MenuItem("자동 방송", toggle_auto, checked=auto_on),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("종료", lambda: self.quit()),
        )
        self.icon = pystray.Icon("JeongsiBroadcast", app_icon(TEAL), APP_NAME, menu)
        self.icon.run_detached()
        threading.Thread(target=self._tray_watch, name="tray-watch", daemon=True).start()

    def _tray_watch(self) -> None:
        """방송 중이면 트레이 아이콘을 주황색으로 바꾼다."""
        last = None
        stop = threading.Event()
        while not self.quitting and not stop.wait(1.0):
            live = self.application.services.runner.on_air
            if live != last and self.icon is not None:
                self.icon.icon = app_icon(ORANGE if live else TEAL)
                self.icon.title = f"{APP_NAME} · 방송 중" if live else APP_NAME
                last = live



def _start_server(application: Application, port: int):
    import uvicorn

    config = uvicorn.Config(create_app(application.services), host="127.0.0.1", port=port, log_level="warning", log_config=None)
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, name="server", daemon=True)
    thread.start()
    return server, thread


def run_desktop(args, data_dir: Path) -> int:
    url = f"http://127.0.0.1:{args.port}/"
    shell = DesktopShell(url)
    application = build_application(data_dir, args.port, shell)
    shell.application = application
    if shell.exe_path():
        cleanup_old_exe(shell.exe_path())
    settings = application.services.store.config.settings
    try:
        autostart.set_enabled(settings.autostart)  # exe를 옮겼어도 경로를 맞춘다
    except OSError:
        log.exception("자동 실행 등록 실패")

    application.start()
    server, server_thread = _start_server(application, args.port)
    shell.start_tray()
    hidden = args.autostart and not settings.open_window_on_autostart
    try:
        import webview

        webview.settings["ALLOW_DOWNLOADS"] = True
        shell.window = webview.create_window(APP_NAME, url, width=1280, height=820, min_size=(960, 640), hidden=hidden)
        shell.window.events.closing += shell.on_closing
        webview.start(private_mode=False)
    except Exception:
        log.exception("앱 창을 열 수 없어 기본 브라우저를 씁니다(WebView2가 없을 수 있음)")
        shell.window = None
        shell.browser_mode = True
        if not hidden:
            webbrowser.open(url)
        shell._browser_exit.wait()
    finally:
        shell.quitting = True
        if shell.icon is not None:
            shell.icon.stop()
        application.stop()
        server.should_exit = True
        server_thread.join(5)
    return 0
