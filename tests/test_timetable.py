import importlib
from datetime import date, datetime

import pytest

from jeongsi.models import DayOff, Override, Slot
from jeongsi.timetable import build_week, describe_next, visible_weekdays

from .conftest import FRI, MON, make_config

NOW = datetime(2026, 11, 20, 11, 18)


def cells(week, slot_id):
    return next(r for r in week["rows"] if r["slot"]["id"] == slot_id)["cells"]


def test_status_for_each_kind_of_cell():
    # Arrange
    cfg = make_config()
    cfg.days_off = [DayOff(start=date(2026, 11, 18), end=date(2026, 11, 18), memo="개교기념일")]
    cfg.overrides = [
        Override(date=date(2026, 11, 19), slot_id="home", action="skip"),
        Override(date=FRI, slot_id="lunch", action="change", time="12:30"),
    ]
    # Act
    week = build_week(cfg, MON, NOW, live=None)
    # Assert: 기록을 남기지 않으므로 지난 회차는 모두 past
    lunch = [c["status"] for c in cells(week, "lunch")]
    assert lunch == ["past", "past", "off", "past", "next"]
    assert cells(week, "lunch")[4]["changed"] and cells(week, "lunch")[4]["original_time"] == "12:00"
    assert cells(week, "home")[3]["status"] == "off"
    assert cells(week, "home")[4]["status"] == "scheduled"
    assert week["days"][2]["day_off"]["memo"] == "개교기념일"
    assert week["days"][4]["is_today"]


def test_live_cell_wins_over_other_status():
    week = build_week(make_config(), MON, NOW, live=(FRI, "morning"))
    assert cells(week, "morning")[4]["status"] == "live"


def test_week_start_is_normalized_to_monday():
    week = build_week(make_config(), FRI, NOW, live=None)
    assert week["start"] == "2026-11-16"


def test_weekend_columns_appear_only_when_used():
    cfg = make_config()
    assert visible_weekdays(cfg) == [0, 1, 2, 3, 4]
    cfg.slots.append(Slot(name="토요 행사", time="10:00", weekdays=[5], program_id="p1"))
    assert visible_weekdays(cfg) == [0, 1, 2, 3, 4, 5]


def test_slot_not_on_that_day_is_none():
    cfg = make_config()
    cfg.slots[0].weekdays = [0]
    assert [c["status"] for c in cells(build_week(cfg, MON, NOW, None), "morning")][1:] == ["none"] * 4


def test_describe_next_includes_units_and_time_left():
    nxt = describe_next(make_config(), NOW, lambda name: 4.0)
    assert nxt["time"] == "12:00" and nxt["in_seconds"] == 42 * 60
    assert [u["label"] for u in nxt["units"]] == ["차임", "음성 · 반복 1/2", "음성 · 반복 2/2"]


def test_describe_next_is_none_when_auto_off():
    cfg = make_config()
    cfg.settings.auto_broadcast = False
    assert describe_next(cfg, NOW, lambda name: 1.0) is None


@pytest.mark.parametrize("module", [
    "jeongsi.__main__", "jeongsi.bootstrap", "jeongsi.desktop", "jeongsi.autostart", "jeongsi.audio.windows", "jeongsi.icon",
])
def test_modules_import_without_windows(module):
    # Windows 전용 라이브러리는 함수 안에서만 불러오므로 어디서나 import 된다
    importlib.import_module(module)
