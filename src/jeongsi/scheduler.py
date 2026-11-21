"""예정 시각이 되면 방송 실행기에 방송을 넣는 시계 루프.

예정 시각에서 GRACE(60초)가 지나도록 실행하지 못한 방송은 놓친 것으로 보고 건너뛴다(기록하지 않음).
최근에 내보낸 회차 키만 잠깐 파일에 남겨, 앱이 다시 시작돼도 같은 방송을 두 번 내보내지 않는다.
"""

from __future__ import annotations

import json
import logging
import threading
from collections.abc import Callable
from datetime import datetime, timedelta
from pathlib import Path

from .runner import Job
from .schedule import Occurrence, occurrences_between, resolve_day
from .storage import ConfigStore, atomic_write_text

log = logging.getLogger(__name__)

GRACE = timedelta(seconds=60)
LOOKAHEAD = timedelta(minutes=5)  # 이만큼 앞의 방송을 미리 봐 둔다
RESUME_GAP = timedelta(seconds=10)  # 확인 간격이 이보다 길면 끊겼다가 이어진 것으로 본다
FIRED_KEEP = timedelta(minutes=10)  # 유예 시간보다 넉넉하게만 보관


def _key(occ: Occurrence) -> str:
    return f"{occ.date.isoformat()}|{occ.slot_id}|{occ.time.strftime('%H:%M')}"


class Scheduler:
    def __init__(
        self,
        store: ConfigStore,
        enqueue: Callable[[Job], None],
        now: Callable[[], datetime] = datetime.now,
        interval: float = 1.0,
        grace: timedelta = GRACE,
        state_path: Path | None = None,
    ):
        self._store = store
        self._enqueue = enqueue
        self._now = now
        self._interval = interval
        self._grace = grace
        self._state_path = state_path
        self._fired: dict[str, str] = self._load()  # 키 → 예정 시각(ISO)
        # 시각 전에 미리 본 방송만 늦게라도 내보낸다. 이미 지난 시각으로 새로 만들거나 옮긴 방송이
        # 화면에는 '지남'인데 바로 나가는 일을 막는다.
        self._upcoming: dict[str, str] = {}
        self._last_tick: datetime | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name="scheduler", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(5)

    def tick(self) -> list[Job]:
        """지금 실행할 방송을 대기열에 넣고, 넣은 방송 목록을 돌려준다."""
        now = self._now()
        config = self._store.config
        jobs: list[Job] = []
        changed = self._prune(now)
        # 앱을 막 켰거나 절전 등으로 확인이 끊겼으면, 그 사이 시각이 된 방송은 미리 볼 수 없었으므로 유예 안이면 내보낸다
        resumed = self._last_tick is None or now - self._last_tick > RESUME_GAP
        if config.settings.auto_broadcast:
            for occ in occurrences_between(config, now - self._grace, now):
                key = _key(occ)
                if key in self._fired:
                    continue
                self._fired[key] = occ.at.isoformat()
                changed = True
                if not resumed and key not in self._upcoming:
                    log.info("%s %s 방송은 시각이 지난 뒤에 생겨 건너뜁니다", occ.name, occ.time.strftime("%H:%M"))
                    continue
                program = config.program(occ.program_id)
                if program is None:
                    log.error("회차 %s의 방송 구성을 찾을 수 없어 건너뜁니다", occ.name)
                    continue
                job = Job(
                    kind="scheduled", name=occ.name, program=program, slot_id=occ.slot_id, date=occ.date,
                    check=lambda occ=occ: self.still_scheduled(occ),
                )
                jobs.append(job)
        for occ in occurrences_between(config, now, now + LOOKAHEAD):
            self._upcoming.setdefault(_key(occ), occ.at.isoformat())
        self._last_tick = now
        if changed:
            self._save()  # 대기열에 넣기 전에 남겨야 재시작해도 다시 나가지 않는다
        for job in jobs:
            self._enqueue(job)
        return jobs

    def still_scheduled(self, occ: Occurrence) -> bool:
        """대기열에서 기다리는 사이 쉬기·시각 변경·자동 방송 끄기가 적용됐는지 다시 확인한다."""
        config = self._store.config
        if not config.settings.auto_broadcast:
            return False
        for current in resolve_day(config, occ.date):
            if current.slot_id == occ.slot_id:
                return not current.skipped and current.time == occ.time
        return False

    def _prune(self, now: datetime) -> bool:
        cutoff = (now - FIRED_KEEP).isoformat()
        self._upcoming = {k: at for k, at in self._upcoming.items() if at >= cutoff}
        stale = [k for k, at in self._fired.items() if at < cutoff]
        for k in stale:
            del self._fired[k]
        return bool(stale)

    def _load(self) -> dict[str, str]:
        if not self._state_path or not self._state_path.exists():
            return {}
        try:
            data = json.loads(self._state_path.read_text(encoding="utf-8"))
            return {str(k): str(v) for k, v in data.items()}
        except (OSError, ValueError, AttributeError):
            log.warning("스케줄러 상태 파일을 읽지 못해 새로 시작합니다")
            return {}

    def _save(self) -> None:
        if not self._state_path:
            return
        try:
            atomic_write_text(self._state_path, json.dumps(self._fired))
        except OSError:
            log.exception("스케줄러 상태를 저장하지 못했습니다")

    def _loop(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                self.tick()
            except Exception:
                log.exception("스케줄러 확인 중 오류")
