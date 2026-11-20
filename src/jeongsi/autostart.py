"""Windows 로그인 시 자동 실행(HKCU Run 키). 관리자 권한이 필요 없다."""

from __future__ import annotations

import logging
import sys

from . import APP_ID

log = logging.getLogger(__name__)
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


def command() -> str | None:
    """설치된 exe로 실행 중일 때만 등록한다(개발 실행은 등록하지 않음)."""
    if sys.platform != "win32" or not getattr(sys, "frozen", False):
        return None
    return f'"{sys.executable}" --autostart'


def set_enabled(enabled: bool) -> None:
    cmd = command()
    if cmd is None:
        return
    import winreg

    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
        if enabled:
            winreg.SetValueEx(key, APP_ID, 0, winreg.REG_SZ, cmd)
        else:
            try:
                winreg.DeleteValue(key, APP_ID)
            except FileNotFoundError:
                pass
