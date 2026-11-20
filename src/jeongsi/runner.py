"""방송 실행기.

한 번에 하나씩 대기열 순서대로 방송한다. 순서:
  원래 상태 기록 → 미디어 일시정지 → 다른 앱 음소거 → 방송 음량 적용 → 단계 재생 → 역순 복원.
복원은 finally에서 항상 하며, 바꾸기 전 상태를 restore.json에 남겨 앱이 죽어도 다음 실행 때 되돌린다.
"""

from __future__ import annotations

import hashlib
import json
import logging
import queue
import threading
import time as _time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Literal

from .audio.base import AudioBackend
from .history import History, HistoryEntry
from .models import Program, Settings, Step
from .storage import atomic_write_text

log = logging.getLogger(__name__)

JobKind = Literal["scheduled", "manual", "preview"]
TTS_CHARS_PER_SECOND = 7.0  # 합성 전 길이 추정용


class RunnerBusy(Exception):
    pass


@dataclass
class Job:
    kind: JobKind
    name: str
    program: Program
    slot_id: str | None = None
    date: date | None = None

    @property
    def ducks(self) -> bool:
        """다른 소리를 멈추고 음량을 맞추는지. 미리듣기는 하지 않는다."""
        return self.kind != "preview"


@dataclass
class PlayUnit:
    step: Step
    repeat_index: int
    label: str
    seconds: float


@dataclass
class RestoreState:
    paused: list[str] = field(default_factory=list)
    muted: list[str] = field(default_factory=list)
    volume: tuple[float, bool] | None = None


def estimate_step_seconds(step: Step, file_seconds: Callable[[str], float | None]) -> float:
    if step.kind == "tts":
        return max(1.0, len(step.text.strip()) / (TTS_CHARS_PER_SECOND * step.rate))
    return file_seconds(step.file) or 0.0


def expand_program(program: Program, file_seconds: Callable[[str], float | None]) -> list[PlayUnit]:
    units = []
    for step in program.steps:
        seconds = estimate_step_seconds(step, file_seconds)
        for i in range(step.repeat):
            label = step.display_label
            if step.repeat > 1:
                label += f" · 반복 {i + 1}/{step.repeat}"
            units.append(PlayUnit(step=step, repeat_index=i, label=label, seconds=seconds))
    return units


def estimate_program_seconds(program: Program, file_seconds: Callable[[str], float | None]) -> float:
    total = 0.0
    for step in program.steps:
        total += estimate_step_seconds(step, file_seconds) * step.repeat + step.gap_sec * (step.repeat - 1)
    return total


class Runner:
    def __init__(
        self,
        audio: AudioBackend,
        settings: Callable[[], Settings],
        history: History,
        media_dir: Path,
        work_dir: Path,
        now: Callable[[], datetime] = datetime.now,
        on_change: Callable[[], None] | None = None,
    ):
        self._audio = audio
        self._settings = settings
        self._history = history
        self._media_dir = media_dir
        self._work_dir = work_dir
        self._now = now
        self._on_change = on_change or (lambda: None)
        self._queue: queue.Queue[Job | None] = queue.Queue()
        self._interrupt = threading.Event()
        self._stop_requested = False
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._status: dict = {"state": "idle"}
        self._restore_path = work_dir / "restore.json"

    # 공개 API --------------------------------------------------------------
    def start(self) -> None:
        self._work_dir.mkdir(parents=True, exist_ok=True)
        self._clear_tts_cache()
        self.recover()
        self._thread = threading.Thread(target=self._loop, name="runner", daemon=True)
        self._thread.start()

    def shutdown(self, timeout: float = 10.0) -> None:
        self.stop_current()
        self._queue.put(None)
        if self._thread:
            self._thread.join(timeout)

    def enqueue(self, job: Job) -> None:
        if job.kind == "preview" and self.busy:
            raise RunnerBusy("방송 중에는 미리듣기를 할 수 없습니다.")
        self._queue.put(job)

    @property
    def busy(self) -> bool:
        with self._lock:
            return self._status["state"] != "idle" or not self._queue.empty()

    @property
    def on_air(self) -> bool:
        with self._lock:
            return self._status["state"] != "idle" and self._status.get("kind") != "preview"

    def stop_current(self) -> bool:
        """지금 방송(또는 미리듣기)을 끈다. 끌 것이 없으면 False."""
        with self._lock:
            if self._status["state"] == "idle":
                return False
            self._stop_requested = True
        self._interrupt.set()
        return True

    def skip_current(self) -> bool:
        """지금 재생 중인 단위를 건너뛰고 다음으로 간다."""
        with self._lock:
            if self._status["state"] != "playing":
                return False
        self._interrupt.set()
        return True

    def status(self) -> dict:
        with self._lock:
            snap = dict(self._status)
        if snap.get("play_started") is not None:
            snap["play_elapsed"] = round(_time.monotonic() - snap.pop("play_started"), 1)
        else:
            snap.pop("play_started", None)
        return snap

    def recover(self) -> None:
        """이전 실행이 방송 도중 끝났으면 원래 소리 상태로 되돌린다."""
        if not self._restore_path.exists():
            return
        try:
            raw = json.loads(self._restore_path.read_text(encoding="utf-8"))
            volume = raw.get("volume")
            state = RestoreState(
                paused=list(raw.get("paused", [])),
                muted=list(raw.get("muted", [])),
                volume=(float(volume[0]), bool(volume[1])) if volume else None,
            )
        except (OSError, ValueError, TypeError, IndexError):
            log.exception("restore.json을 읽지 못했습니다")
            self._restore_path.unlink(missing_ok=True)
            return
        log.warning("이전 방송이 끝나지 않은 상태로 종료되어 소리 상태를 복원합니다")
        self._restore(state)

    # 내부 ------------------------------------------------------------------
    def _loop(self) -> None:
        while True:
            job = self._queue.get()
            if job is None:
                return
            try:
                self._execute(job)
            except Exception:  # 실행기 스레드는 죽지 않는다
                log.exception("방송 실행 중 예상치 못한 오류")

    def _set_status(self, **values) -> None:
        with self._lock:
            self._status.update(values)
        self._on_change()

    def _execute(self, job: Job) -> None:
        settings = self._settings()
        units = expand_program(job.program, self._file_seconds)
        with self._lock:
            self._stop_requested = False
            self._interrupt.clear()
            self._status = {
                "state": "preparing",
                "kind": job.kind,
                "name": job.name,
                "slot_id": job.slot_id,
                "date": job.date.isoformat() if job.date else None,
                "program_id": job.program.id,
                "plays": [{"label": u.label, "seconds": round(u.seconds, 1)} for u in units],
                "index": 0,
                "play_started": None,
            }
        self._on_change()
        started_at = self._now()
        result, error = "done", ""
        restore = RestoreState()
        try:
            if job.ducks:
                self._duck(restore, settings)
            self._set_status(state="playing")
            self._play_units(units, settings)
            if self._stop_requested:
                result = "stopped"
        except Exception as exc:
            log.exception("방송 실패: %s", job.name)
            result, error = "failed", str(exc)[:200]
        finally:
            self._set_status(state="restoring", play_started=None)
            if job.ducks:
                self._restore(restore)
            with self._lock:
                self._status = {"state": "idle"}
            if job.kind != "preview":
                self._history.append(
                    HistoryEntry(
                        kind=job.kind,  # type: ignore[arg-type]
                        name=job.name,
                        slot_id=job.slot_id,
                        date=job.date,
                        started_at=started_at,
                        ended_at=self._now(),
                        result=result,  # type: ignore[arg-type]
                        error=error,
                    )
                )
            self._on_change()

    def _play_units(self, units: list[PlayUnit], settings: Settings) -> None:
        tts_cache: dict[str, Path] = {}
        for index, unit in enumerate(units):
            if self._stop_requested:
                return
            path = self._resolve(unit.step, settings, tts_cache)
            actual = self._audio.player.duration(path)
            with self._lock:
                self._status["index"] = index
                self._status["play_started"] = _time.monotonic()
                if actual:
                    self._status["plays"][index]["seconds"] = round(actual, 1)
            self._on_change()
            self._audio.player.play(path, self._interrupt)
            if self._stop_requested:
                return
            self._interrupt.clear()  # 건너뛰기 요청은 이 단위에서 소비
            is_last_repeat = unit.repeat_index == unit.step.repeat - 1
            if not is_last_repeat and unit.step.gap_sec > 0:
                self._interrupt.wait(unit.step.gap_sec)
                if self._stop_requested:
                    return
                self._interrupt.clear()

    def _resolve(self, step: Step, settings: Settings, tts_cache: dict[str, Path]) -> Path:
        if step.kind == "audio":
            path = self._media_dir / step.file
            if not path.exists():
                raise FileNotFoundError(f"소리 파일이 없습니다: {step.file}")
            return path
        if step.id in tts_cache:
            return tts_cache[step.id]
        voice = step.voice or settings.default_voice
        key = hashlib.sha1(f"{step.text}|{voice}|{step.rate}".encode()).hexdigest()[:16]
        path = self._work_dir / "tts" / f"{key}.wav"
        if not path.exists():
            self._audio.speech.synthesize(step.text, voice, step.rate, path)
        tts_cache[step.id] = path
        return path

    def _duck(self, state: RestoreState, settings: Settings) -> None:
        if settings.pause_media:
            state.paused = self._audio.media.pause_playing()
            self._save_restore(state)
        if settings.mute_others:
            state.muted = self._audio.muter.mute_others()
            self._save_restore(state)
        if settings.set_volume:
            state.volume = self._audio.volume.get()
            self._save_restore(state)  # 바꾸기 전에 기록
            self._audio.volume.set(settings.volume / 100, False)

    def _restore(self, state: RestoreState) -> None:
        steps: list[tuple[str, Callable[[], None]]] = []
        if state.volume is not None:
            level, muted = state.volume
            steps.append(("음량", lambda: self._audio.volume.set(level, muted)))
        if state.muted:
            steps.append(("음소거", lambda: self._audio.muter.unmute(state.muted)))
        if state.paused:
            steps.append(("일시정지", lambda: self._audio.media.resume(state.paused)))
        for name, action in steps:
            try:
                action()
            except Exception:  # 하나가 실패해도 나머지는 되돌린다
                log.exception("%s 복원 실패", name)
        self._restore_path.unlink(missing_ok=True)

    def _save_restore(self, state: RestoreState) -> None:
        atomic_write_text(self._restore_path, json.dumps(asdict(state)))

    def _file_seconds(self, name: str) -> float | None:
        path = self._media_dir / name
        return self._audio.player.duration(path) if path.exists() else None

    def _clear_tts_cache(self) -> None:
        for path in (self._work_dir / "tts").glob("*.wav"):
            path.unlink(missing_ok=True)
