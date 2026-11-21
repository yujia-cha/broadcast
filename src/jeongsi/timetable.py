"""주간 시간표 화면에 보여 줄 데이터를 만든다."""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime, timedelta

from .models import WEEKDAY_NAMES, Config
from .runner import estimate_program_seconds, expand_program
from .schedule import next_occurrence, resolve_day


def week_start(day: date) -> date:
    return day - timedelta(days=day.weekday())


def visible_weekdays(config: Config, start: date | None = None) -> list[int]:
    """평일은 항상, 주말은 그 주에 방송(꺼 둔 것 포함)이 있을 때만 보인다."""
    days = {0, 1, 2, 3, 4}
    week = [start + timedelta(days=i) for i in range(7)] if start else []
    for slot in config.slots:
        if slot.dates:
            days.update(d.weekday() for d in week if d in slot.dates)
        else:
            days.update(slot.weekdays)
    return sorted(days)


def home_week_start(config: Config, today: date) -> date:
    """처음 보여 줄 주. 오늘이 이번 주 화면에 없으면(방송 없는 주말) 다음 주."""
    start = week_start(today)
    if today.weekday() not in visible_weekdays(config, start):
        return start + timedelta(days=7)
    return start


def build_week(
    config: Config,
    start: date,
    now: datetime,
    live: tuple[date, str] | None,
) -> dict:
    """회차(행) × 요일(열) 표. 칸 상태: scheduled, next, past, off, live, disabled(꺼 둔 회차), none.

    방송 기록을 남기지 않으므로 지난 회차는 방송 여부와 관계없이 past로 표시한다.
    """
    start = week_start(start)
    weekdays = visible_weekdays(config, start)
    dates = [start + timedelta(days=i) for i in weekdays]
    nxt = next_occurrence(config, now) if config.settings.auto_broadcast else None
    next_key = nxt.key if nxt else None

    by_day = {d: {o.slot_id: o for o in resolve_day(config, d)} for d in dates}
    days = []
    for d in dates:
        off = config.day_off_for(d)
        days.append(
            {
                "date": d.isoformat(),
                "label": WEEKDAY_NAMES[d.weekday()],
                "is_today": d == now.date(),
                "day_off": {"id": off.id, "memo": off.memo, "start": off.start.isoformat(), "end": off.end.isoformat()} if off else None,
            }
        )

    rows = []
    for slot in sorted(config.slots, key=lambda s: (s.time, s.name)):
        program = config.program(slot.program_id)
        cells = []
        for d in dates:
            occ = by_day[d].get(slot.id)
            override = config.override_for(d, slot.id)
            cell: dict = {"date": d.isoformat(), "override": override.model_dump(mode="json") if override else None}
            if occ is None and not slot.enabled and slot.matches(d):
                # 꺼 둔 회차도 흐리게 보여 줘야 다시 켤 수 있다
                cell.update(time=slot.time, original_time=slot.time, changed=False, program_id=slot.program_id,
                            program_name=program.name if program else "", summary=program.summary() if program else "",
                            strip=[{"kind": st.kind, "repeat": st.repeat} for st in program.steps] if program else [],
                            status="disabled")
            elif occ is None:
                cell["status"] = "none"
            else:
                occ_program = config.program(occ.program_id)
                cell.update(
                    time=occ.time.strftime("%H:%M"),
                    original_time=occ.original_time.strftime("%H:%M"),
                    changed=occ.changed,
                    program_id=occ.program_id,
                    program_name=occ_program.name if occ_program else "",
                    summary=occ_program.summary() if occ_program else "",
                    strip=[{"kind": st.kind, "repeat": st.repeat} for st in occ_program.steps] if occ_program else [],
                    status=_cell_status(occ, now, live, next_key),
                )
            cells.append(cell)
        rows.append(
            {
                "slot": slot.model_dump(mode="json"),
                "program_name": program.name if program else "",
                "cells": cells,
            }
        )
    return {"start": start.isoformat(), "home": home_week_start(config, now.date()).isoformat(), "days": days, "rows": rows}


def _cell_status(occ, now, live, next_key) -> str:
    if live == occ.key:
        return "live"
    if occ.skipped:
        return "off"
    if occ.at <= now:
        return "past"
    return "next" if next_key == occ.key else "scheduled"


def describe_next(config: Config, now: datetime, file_seconds: Callable[[str], float | None]) -> dict | None:
    if not config.settings.auto_broadcast:
        return None
    occ = next_occurrence(config, now)
    if occ is None:
        return None
    program = config.program(occ.program_id)
    if program is None:
        return None
    units = expand_program(program, file_seconds)
    return {
        "date": occ.date.isoformat(),
        "time": occ.time.strftime("%H:%M"),
        "slot_id": occ.slot_id,
        "name": occ.name,
        "program_id": program.id,
        "summary": program.summary(),
        "seconds": round(estimate_program_seconds(program, file_seconds)),
        "units": [{"label": u.label, "kind": u.step.kind, "seconds": round(u.seconds, 1)} for u in units],
        "in_seconds": int((occ.at - now).total_seconds()),
        "changed": occ.changed,
    }
