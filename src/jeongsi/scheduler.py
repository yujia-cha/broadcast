"""예정 시각이 되면 방송 실행기에 방송을 넣는 시계 루프.

예정 시각에서 GRACE(60초)가 지나도록 실행하지 못한 방송은 놓친 것으로 보고 건너뛴다(기록하지 않음).
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from datetime import date, datetime, time, timedelta

from .runner import Job
from .schedule import occurrences_between
from .storage import ConfigStore

log = logging.getLogger(__name__)

GRACE = timedelta(seconds=60)


class Scheduler:
    def __init__(
        self,
        store: ConfigStore,
        enqueue: Callable[[Job], None],
        now: Callable[[], datetime] = datetime.now,
        interval: float = 1.0,
        grace: timedelta = GRACE,
    ):
        self._store = store
        self._enqueue = enqueue
        self._now = now
        self._interval = interval
        self._grace = grace
        self._fired: set[tuple[date, str, time]] = set()
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
        if config.settings.auto_broadcast:
            for occ in occurrences_between(config, now - self._grace, now):
                key = (occ.date, occ.slot_id, occ.time)
                if key in self._fired:
                    continue
                self._fired.add(key)
                program = config.program(occ.program_id)
                if program is None:
                    log.error("회차 %s의 방송 구성을 찾을 수 없어 건너뜁니다", occ.name)
                    continue
                job = Job(kind="scheduled", name=occ.name, program=program, slot_id=occ.slot_id, date=occ.date)
                self._enqueue(job)
                jobs.append(job)
        cutoff = now.date() - timedelta(days=2)
        self._fired = {k for k in self._fired if k[0] >= cutoff}
        return jobs

    def _loop(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                self.tick()
            except Exception:
                log.exception("스케줄러 확인 중 오류")
