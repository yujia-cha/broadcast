from datetime import date, datetime, time

from jeongsi.models import DayOff, Override
from jeongsi.schedule import next_occurrence, occurrences_between, resolve_day

from .conftest import FRI, MON, SAT, WED, make_config


def test_weekday_returns_all_slots_in_time_order(config):
    # Act
    occs = resolve_day(config, MON)
    # Assert
    assert [o.slot_id for o in occs] == ["morning", "lunch", "home"]
    assert not any(o.skipped for o in occs)


def test_weekend_has_no_occurrences(config):
    assert resolve_day(config, SAT) == []


def test_disabled_slot_is_excluded(config):
    config.slots[1].enabled = False
    assert [o.slot_id for o in resolve_day(config, MON)] == ["morning", "home"]


def test_single_day_off_skips_every_slot(config):
    config.days_off = [DayOff(start=WED, end=WED, memo="개교기념일")]
    assert all(o.skipped for o in resolve_day(config, WED))
    assert not any(o.skipped for o in resolve_day(config, MON))


def test_range_day_off_includes_both_ends(config):
    # Arrange: 11/18(수) ~ 11/20(금)
    config.days_off = [DayOff(start=WED, end=FRI)]
    # Act / Assert
    assert all(o.skipped for o in resolve_day(config, WED))
    assert all(o.skipped for o in resolve_day(config, FRI))
    assert not any(o.skipped for o in resolve_day(config, date(2026, 11, 17)))


def test_skip_override_skips_only_that_slot(config):
    config.overrides = [Override(date=FRI, slot_id="lunch", action="skip")]
    occs = {o.slot_id: o for o in resolve_day(config, FRI)}
    assert occs["lunch"].skipped
    assert not occs["morning"].skipped


def test_change_override_moves_time_and_reorders(config):
    config.overrides = [Override(date=FRI, slot_id="lunch", action="change", time="17:00")]
    occs = resolve_day(config, FRI)
    assert [o.slot_id for o in occs] == ["morning", "home", "lunch"]
    lunch = occs[-1]
    assert lunch.changed and lunch.time == time(17, 0) and lunch.original_time == time(12, 0)


def test_change_override_wins_over_day_off(config):
    # 쉬는 기간이어도 그 날짜 회차를 바꾸기로 지정하면 방송한다
    config.days_off = [DayOff(start=MON, end=FRI)]
    config.overrides = [Override(date=FRI, slot_id="lunch", action="change", program_id="p2")]
    occs = {o.slot_id: o for o in resolve_day(config, FRI)}
    assert not occs["lunch"].skipped and occs["lunch"].program_id == "p2"
    assert occs["morning"].skipped


def test_override_on_day_without_slot_is_ignored(config):
    config.overrides = [Override(date=SAT, slot_id="lunch", action="change", time="10:00")]
    assert resolve_day(config, SAT) == []


def test_next_occurrence_same_day(config):
    nxt = next_occurrence(config, datetime(2026, 11, 20, 11, 18))
    assert (nxt.date, nxt.slot_id) == (FRI, "lunch")


def test_next_occurrence_skips_weekend_and_skipped(config):
    # 금요일 하교 이후 → 다음 주 월요일 아침
    config.overrides = [Override(date=date(2026, 11, 23), slot_id="morning", action="skip")]
    nxt = next_occurrence(config, datetime(2026, 11, 20, 16, 0))
    assert (nxt.date, nxt.slot_id) == (date(2026, 11, 23), "lunch")


def test_next_occurrence_none_when_no_slots():
    cfg = make_config()
    cfg.slots = []
    assert next_occurrence(cfg, datetime(2026, 11, 20, 9, 0)) is None


def test_occurrences_between_excludes_start_includes_end(config):
    start, end = datetime(2026, 11, 20, 8, 50), datetime(2026, 11, 20, 12, 0)
    assert [o.slot_id for o in occurrences_between(config, start, end)] == ["lunch"]


def test_occurrences_between_spans_midnight(config):
    config.slots[0].time = "00:00"
    start, end = datetime(2026, 11, 19, 23, 59, 30), datetime(2026, 11, 20, 0, 0, 30)
    assert [(o.date, o.slot_id) for o in occurrences_between(config, start, end)] == [(FRI, "morning")]
