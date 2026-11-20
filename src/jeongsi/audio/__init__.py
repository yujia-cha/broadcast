"""오디오 백엔드 선택."""

from __future__ import annotations

import sys

from .base import AudioBackend


def default_backend(use_fake: bool = False) -> AudioBackend:
    """Windows면 실제 구현, 아니면(또는 use_fake) 소리를 내지 않는 가짜 구현."""
    if use_fake or sys.platform != "win32":
        from .fake import fake_backend

        return fake_backend(speed=1.0)
    from .windows import windows_backend

    return windows_backend()
