"""날짜별 실제 방송 일정을 계산한다.

우선순위: 회차 변경(Override) > 쉬는 날(DayOff) > 주간 일정(Slot).
쉬는 날이어도 그 날짜 회차를 "바꾸기"로 지정했으면 방송한다.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from .models import Config, parse_hhmm


@dataclass(frozen=True)
class Occurrence:
    date: date
    slot_id: str
    name: str
    time: time
    program_id: str
    skipped: bool
    changed: bool
    original_time: time

    @property
    def at(self) -> datetime:
        return datetime.combine(self.date, self.time)

    @property
    def key(self) -> tuple[date, str]:
        return (self.date, self.slot_id)


def resolve_day(config: Config, day: date) -> list[Occurrence]:
    """그 날짜에 해당하는 모든 회차(쉬는 회차 포함)를 시각 순으로 돌려준다."""
    day_off = config.day_off_for(day)
    result: list[Occurrence] = []
    for slot in config.slots:
        if not slot.enabled or day.weekday() not in slot.weekdays:
            continue
        base_time = parse_hhmm(slot.time)
        override = config.override_for(day, slot.id)
        when, program_id, skipped, changed = base_time, slot.program_id, False, False
        if override is not None and override.action == "skip":
            skipped = True
        elif override is not None and override.action == "change":
            when = parse_hhmm(override.time) if override.time else base_time
            program_id = override.program_id or slot.program_id
            changed = True
        elif day_off is not None:
            skipped = True
        result.append(
            Occurrence(
                date=day,
                slot_id=slot.id,
                name=slot.name,
                time=when,
                program_id=program_id,
                skipped=skipped,
                changed=changed,
                original_time=base_time,
            )
        )
    result.sort(key=lambda o: (o.time, o.name))
    return result


def occurrences_between(config: Config, start: datetime, end: datetime) -> Iterator[Occurrence]:
    """start < 시각 <= end 인 방송(쉬는 회차 제외)을 시각 순으로 돌려준다."""
    day = start.date()
    while day <= end.date():
        for occ in resolve_day(config, day):
            if not occ.skipped and start < occ.at <= end:
                yield occ
        day += timedelta(days=1)


def next_occurrence(config: Config, now: datetime, search_days: int = 60) -> Occurrence | None:
    """now 이후 첫 방송. 쉬는 회차는 건너뛴다."""
    for offset in range(search_days + 1):
        day = now.date() + timedelta(days=offset)
        for occ in resolve_day(config, day):
            if not occ.skipped and occ.at > now:
                return occ
    return None
