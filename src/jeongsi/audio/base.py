"""오디오 제어 인터페이스. 방송 실행기는 이 인터페이스만 알고, Windows 구현과 가짜 구현을 바꿔 끼운다."""

from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class Voice:
    id: str
    name: str
    language: str


class MediaSessions(Protocol):
    def pause_playing(self) -> list[str]:
        """재생 중인 미디어(영상·음악)를 일시정지하고, 멈춘 세션 id를 돌려준다."""

    def resume(self, session_ids: list[str]) -> None:
        """pause_playing이 멈춘 세션만 다시 재생한다."""


class AppMuter(Protocol):
    def mute_others(self) -> list[str]:
        """이 앱을 뺀 모든 앱을 음소거하고, 새로 음소거한 앱 키를 돌려준다(이미 음소거된 앱은 제외)."""

    def unmute(self, keys: list[str]) -> None:
        """mute_others가 음소거한 앱만 해제한다."""


class MasterVolume(Protocol):
    def get(self) -> tuple[float, bool]:
        """(음량 0~1, 음소거 여부)."""

    def set(self, level: float, muted: bool) -> None: ...


class Speech(Protocol):
    def voices(self) -> list[Voice]: ...

    def synthesize(self, text: str, voice_id: str, rate: float, out_path: Path) -> None:
        """문구를 WAV 파일로 만든다. voice_id가 빈 값이면 시스템 기본 음성."""


class Player(Protocol):
    def play(self, path: Path, interrupt: threading.Event) -> None:
        """파일을 끝까지 재생한다. interrupt가 켜지면 바로 멈추고 돌아온다."""

    def duration(self, path: Path) -> float | None: ...


@dataclass
class AudioBackend:
    media: MediaSessions
    muter: AppMuter
    volume: MasterVolume
    speech: Speech
    player: Player
    name: str = "unknown"


class SpeechError(Exception):
    pass
