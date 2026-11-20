from datetime import datetime, timedelta

from jeongsi.models import Override
from jeongsi.scheduler import Scheduler
from jeongsi.storage import ConfigStore

from .conftest import FRI, make_config


class Clock:
    def __init__(self, at: datetime):
        self.at = at

    def __call__(self) -> datetime:
        return self.at


def make(tmp_path, at, **cfg):
    store = ConfigStore(tmp_path / "config.json")
    store.replace(make_config(**cfg))
    clock = Clock(at)
    jobs = []
    return Scheduler(store, jobs.append, now=clock), store, clock, jobs


def test_fires_at_scheduled_time(tmp_path):
    # Arrange
    sched, _, clock, jobs = make(tmp_path, datetime(2026, 11, 20, 11, 59, 59))
    # Act / Assert
    assert sched.tick() == []
    clock.at = datetime(2026, 11, 20, 12, 0, 0)
    sched.tick()
    assert [(j.slot_id, j.date) for j in jobs] == [("lunch", FRI)]


def test_does_not_fire_twice(tmp_path):
    sched, _, clock, jobs = make(tmp_path, datetime(2026, 11, 20, 12, 0, 0))
    sched.tick()
    clock.at += timedelta(seconds=30)
    sched.tick()
    assert len(jobs) == 1


def test_fires_late_within_grace(tmp_path):
    # 앱이 12:00:59에 켜졌으면 아직 방송한다
    sched, _, _, jobs = make(tmp_path, datetime(2026, 11, 20, 12, 0, 59))
    sched.tick()
    assert [j.slot_id for j in jobs] == ["lunch"]


def test_skips_when_grace_passed(tmp_path):
    # 60초가 지나면 놓친 방송으로 보고 건너뛴다
    sched, _, _, jobs = make(tmp_path, datetime(2026, 11, 20, 12, 1, 1))
    sched.tick()
    assert jobs == []


def test_auto_broadcast_off_fires_nothing(tmp_path):
    sched, store, _, jobs = make(tmp_path, datetime(2026, 11, 20, 12, 0, 0))
    store.update(lambda c: setattr(c.settings, "auto_broadcast", False))
    sched.tick()
    assert jobs == []


def test_uses_override_program_and_time(tmp_path):
    overrides = [Override(date=FRI, slot_id="lunch", action="change", time="12:30", program_id="p2")]
    sched, _, clock, jobs = make(tmp_path, datetime(2026, 11, 20, 12, 0, 0), overrides=overrides)
    sched.tick()
    assert jobs == []
    clock.at = datetime(2026, 11, 20, 12, 30, 0)
    sched.tick()
    assert jobs[0].program.id == "p2"


def test_skipped_slot_is_not_fired(tmp_path):
    overrides = [Override(date=FRI, slot_id="lunch", action="skip")]
    sched, _, _, jobs = make(tmp_path, datetime(2026, 11, 20, 12, 0, 0), overrides=overrides)
    sched.tick()
    assert jobs == []
