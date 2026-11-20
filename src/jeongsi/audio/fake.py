"""테스트와 개발용(비Windows) 가짜 오디오 구현. 호출 기록을 남겨 테스트에서 확인한다."""

from __future__ import annotations

import threading
import wave
from pathlib import Path

from .base import AudioBackend, Voice


class FakeMedia:
    def __init__(self, playing: list[str] | None = None, calls: list | None = None):
        self.playing = list(playing or [])
        self.paused: list[str] = []
        self.calls = calls if calls is not None else []

    def pause_playing(self) -> list[str]:
        self.calls.append(("pause",))
        ids, self.paused, self.playing = list(self.playing), list(self.playing), []
        return ids

    def resume(self, session_ids: list[str]) -> None:
        self.calls.append(("resume", list(session_ids)))
        self.playing += session_ids
        self.paused = [s for s in self.paused if s not in session_ids]


class FakeMuter:
    def __init__(self, apps: dict[str, bool] | None = None, calls: list | None = None):
        self.apps = dict(apps or {})  # 앱 키 → 음소거 여부
        self.calls = calls if calls is not None else []

    def mute_others(self) -> list[str]:
        self.calls.append(("mute",))
        newly = [k for k, muted in self.apps.items() if not muted]
        for k in newly:
            self.apps[k] = True
        return newly

    def unmute(self, keys: list[str]) -> None:
        self.calls.append(("unmute", list(keys)))
        for k in keys:
            if k in self.apps:
                self.apps[k] = False


class FakeVolume:
    def __init__(self, level: float = 0.3, muted: bool = True, calls: list | None = None):
        self.level, self.muted = level, muted
        self.calls = calls if calls is not None else []

    def get(self) -> tuple[float, bool]:
        return self.level, self.muted

    def set(self, level: float, muted: bool) -> None:
        self.calls.append(("volume", round(level, 2), muted))
        self.level, self.muted = level, muted


class FakeSpeech:
    """1초짜리 무음 WAV를 만든다."""

    def __init__(self, fail: bool = False, seconds: float = 1.0):
        self.fail = fail
        self.seconds = seconds
        self.requests: list[tuple[str, str, float]] = []

    def voices(self) -> list[Voice]:
        return [Voice(id="fake-ko", name="가짜 한국어 음성", language="ko-KR")]

    def synthesize(self, text: str, voice_id: str, rate: float, out_path: Path) -> None:
        self.requests.append((text, voice_id, rate))
        if self.fail:
            raise RuntimeError("음성 합성 실패(테스트)")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(out_path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(8000)
            w.writeframes(b"\x00\x00" * int(8000 * self.seconds))


class FakePlayer:
    """실제로 소리를 내지 않고 길이만큼(× speed) 기다린다. block=True면 interrupt가 올 때까지 기다린다."""

    def __init__(self, speed: float = 0.0, default_seconds: float = 3.0, block: bool = False, fail_on: str | None = None):
        self.speed = speed
        self.default_seconds = default_seconds
        self.block = block
        self.fail_on = fail_on
        self.played: list[str] = []
        self.started = threading.Event()

    def play(self, path: Path, interrupt: threading.Event) -> None:
        self.played.append(Path(path).name)
        self.started.set()
        if self.fail_on and self.fail_on in Path(path).name:
            raise RuntimeError("재생 실패(테스트)")
        if self.block:
            interrupt.wait()
            return
        seconds = (self.duration(path) or self.default_seconds) * self.speed
        interrupt.wait(seconds)

    def duration(self, path: Path) -> float | None:
        path = Path(path)
        if path.suffix.lower() == ".wav" and path.exists():
            try:
                with wave.open(str(path), "rb") as w:
                    return w.getnframes() / float(w.getframerate())
            except (wave.Error, EOFError):
                return None
        try:
            import miniaudio

            return miniaudio.get_file_info(str(path)).duration
        except Exception:
            return self.default_seconds if path.exists() else None


def fake_backend(speed: float = 0.0, **kwargs) -> AudioBackend:
    calls: list = []
    return AudioBackend(
        media=FakeMedia(kwargs.get("playing", ["chrome"]), calls),
        muter=FakeMuter(kwargs.get("apps", {"chrome": False, "game": False, "already": True}), calls),
        volume=FakeVolume(calls=calls),
        speech=FakeSpeech(),
        player=FakePlayer(speed=speed),
        name="fake",
    )
