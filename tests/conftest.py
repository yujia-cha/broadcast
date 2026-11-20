from __future__ import annotations

from datetime import date

import pytest

from jeongsi.models import Config, DayOff, Override, Program, Slot, Step

# 2026-11-16은 월요일
MON = date(2026, 11, 16)
WED = date(2026, 11, 18)
FRI = date(2026, 11, 20)
SAT = date(2026, 11, 21)


def make_program(pid: str = "p1", name: str = "점심 안내") -> Program:
    return Program(
        id=pid,
        name=name,
        steps=[
            Step(kind="audio", file="a1b2c3d4-chime.wav", label="차임"),
            Step(kind="tts", text="점심시간입니다.", repeat=2, gap_sec=1),
        ],
    )


def make_config(**overrides) -> Config:
    cfg = Config(
        programs=[make_program("p1", "점심 안내"), make_program("p2", "하교 안내")],
        slots=[
            Slot(id="morning", name="아침 조회", time="08:50", weekdays=[0, 1, 2, 3, 4], program_id="p1"),
            Slot(id="lunch", name="점심 안내", time="12:00", weekdays=[0, 1, 2, 3, 4], program_id="p1"),
            Slot(id="home", name="하교 안내", time="16:00", weekdays=[0, 1, 2, 3, 4], program_id="p2"),
        ],
    )
    for key, value in overrides.items():
        setattr(cfg, key, value)
    return cfg


@pytest.fixture
def config() -> Config:
    return make_config()


__all__ = ["MON", "WED", "FRI", "SAT", "make_config", "make_program", "DayOff", "Override"]
