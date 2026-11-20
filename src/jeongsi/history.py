"""실제로 방송한 기록(완료·정지·실패). 건너뛴 방송과 그 이유는 기록하지 않는다."""

from __future__ import annotations

import json
import logging
import threading
import datetime as dt
from datetime import date, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from .models import new_id
from .storage import atomic_write_text

log = logging.getLogger(__name__)

Result = Literal["done", "stopped", "failed"]
MAX_LINES = 5000
KEEP_LINES = 2000


class HistoryEntry(BaseModel):
    id: str = Field(default_factory=new_id)
    kind: Literal["scheduled", "manual"]
    name: str
    slot_id: str | None = None
    date: dt.date | None = None  # 예약 방송의 날짜
    started_at: datetime
    ended_at: datetime
    result: Result
    error: str = ""


class History:
    def __init__(self, path: Path):
        self._path = path
        self._lock = threading.Lock()
        self._cache: list[HistoryEntry] | None = None

    def append(self, entry: HistoryEntry) -> None:
        with self._lock:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with open(self._path, "a", encoding="utf-8") as fh:
                fh.write(entry.model_dump_json() + "\n")
            entries = self._read_all()
            entries.append(entry)
            if len(entries) > MAX_LINES:
                entries = entries[-KEEP_LINES:]
                atomic_write_text(self._path, "".join(e.model_dump_json() + "\n" for e in entries))
            self._cache = entries

    def recent(self, limit: int = 200) -> list[HistoryEntry]:
        with self._lock:
            return list(reversed(self._read_all()))[:limit]

    def results_by_occurrence(self) -> dict[tuple[date, str], Result]:
        """(날짜, 회차) → 마지막 결과. 시간표의 완료 표시에 쓴다."""
        with self._lock:
            return {(e.date, e.slot_id): e.result for e in self._read_all() if e.date and e.slot_id}

    def _read_all(self) -> list[HistoryEntry]:
        if self._cache is not None:
            return list(self._cache)
        entries: list[HistoryEntry] = []
        if self._path.exists():
            for line in self._path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    entries.append(HistoryEntry.model_validate(json.loads(line)))
                except (ValueError, ValidationError):
                    log.warning("기록 한 줄을 읽지 못해 건너뜁니다")
        self._cache = entries
        return list(entries)
