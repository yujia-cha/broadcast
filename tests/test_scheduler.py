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


def test_restart_within_grace_does_not_fire_again(tmp_path):
    # Arrange: 12:00 방송을 내보낸 뒤 12:00:40에 앱이 다시 시작된 상황
    state = tmp_path / "scheduler.json"
    store = ConfigStore(tmp_path / "config.json")
    store.replace(make_config())
    first = []
    Scheduler(store, first.append, now=Clock(datetime(2026, 11, 20, 12, 0, 5)), state_path=state).tick()
    # Act
    second = []
    Scheduler(store, second.append, now=Clock(datetime(2026, 11, 20, 12, 0, 40)), state_path=state).tick()
    # Assert
    assert [j.slot_id for j in first] == ["lunch"] and second == []


def test_state_file_keeps_only_recent_keys(tmp_path):
    state = tmp_path / "scheduler.json"
    sched, _, clock, _ = make(tmp_path, datetime(2026, 11, 20, 12, 0, 0))
    sched._state_path = state
    sched.tick()
    clock.at = datetime(2026, 11, 20, 13, 0, 0)
    sched.tick()
    import json
    assert json.loads(state.read_text(encoding="utf-8")) == {}


def test_corrupt_state_file_is_ignored(tmp_path):
    state = tmp_path / "scheduler.json"
    state.write_text("{깨짐", encoding="utf-8")
    store = ConfigStore(tmp_path / "config.json")
    store.replace(make_config())
    jobs = []
    Scheduler(store, jobs.append, now=Clock(datetime(2026, 11, 20, 12, 0, 0)), state_path=state).tick()
    assert len(jobs) == 1


def test_queued_job_check_sees_later_skip_and_auto_off(tmp_path):
    sched, store, _, jobs = make(tmp_path, datetime(2026, 11, 20, 12, 0, 0))
    sched.tick()
    check = jobs[0].check
    assert check() is True
    store.update(lambda c: c.overrides.append(Override(date=FRI, slot_id="lunch", action="skip")))
    assert check() is False
    store.update(lambda c: setattr(c, "overrides", []))
    store.update(lambda c: setattr(c.settings, "auto_broadcast", False))
    assert check() is False


def test_broadcast_created_after_its_time_does_not_fire(tmp_path):
    # Arrange: 1초마다 확인하는 중에, 08:00:05에 '08:00' 회차가 생긴다(화면에는 '지남')
    sched, store, clock, jobs = make(tmp_path, datetime(2026, 11, 20, 8, 0, 3))
    sched.tick()
    clock.at = datetime(2026, 11, 20, 8, 0, 4)
    sched.tick()
    store.update(lambda c: setattr(c.slots[0], "time", "08:00"))
    # Act
    clock.at = datetime(2026, 11, 20, 8, 0, 5)
    sched.tick()
    # Assert
    assert jobs == []


def test_broadcast_seen_before_its_time_still_fires_after_short_delay(tmp_path):
    # Arrange: 11:59:58에 미리 봐 둔 12:00 방송
    sched, _, clock, jobs = make(tmp_path, datetime(2026, 11, 20, 11, 59, 58))
    sched.tick()
    # Act: 2초 뒤 확인(정상 간격)
    clock.at = datetime(2026, 11, 20, 12, 0, 1)
    sched.tick()
    # Assert
    assert [j.slot_id for j in jobs] == ["lunch"]


def test_resume_after_sleep_fires_within_grace(tmp_path):
    # 11:00에 확인하고 절전, 12:00:30에 깨어나면 유예 안이므로 내보낸다
    sched, _, clock, jobs = make(tmp_path, datetime(2026, 11, 20, 11, 0, 0))
    sched.tick()
    clock.at = datetime(2026, 11, 20, 12, 0, 30)
    sched.tick()
    assert [j.slot_id for j in jobs] == ["lunch"]


def test_turning_auto_back_on_within_a_minute_does_not_fire_late(tmp_path):
    # Arrange: 11:59에 자동 방송을 끄고, 12:00이 지나간 뒤 12:00:30에 다시 켬
    sched, store, clock, jobs = make(tmp_path, datetime(2026, 11, 20, 11, 59, 0))
    sched.tick()
    store.update(lambda c: setattr(c.settings, "auto_broadcast", False))
    for sec in (1, 2, 3):
        clock.at = datetime(2026, 11, 20, 12, 0, sec)
        sched.tick()
    store.update(lambda c: setattr(c.settings, "auto_broadcast", True))
    # Act
    clock.at = datetime(2026, 11, 20, 12, 0, 4)
    sched.tick()
    # Assert
    assert jobs == []
