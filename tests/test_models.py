from datetime import date

import pytest
from pydantic import ValidationError

from jeongsi.models import Config, DayOff, Override, Program, Slot, Step, media_display_name, parse_hhmm

from .conftest import make_config


def test_tts_step_requires_text():
    # Arrange / Act / Assert
    with pytest.raises(ValidationError, match="문구"):
        Step(kind="tts", text="   ")


@pytest.mark.parametrize("repeat", [0, 21])
def test_step_repeat_out_of_range_is_rejected(repeat):
    with pytest.raises(ValidationError):
        Step(kind="tts", text="안내", repeat=repeat)


@pytest.mark.parametrize("repeat", [1, 20])
def test_step_repeat_boundaries_are_accepted(repeat):
    assert Step(kind="tts", text="안내", repeat=repeat).repeat == repeat


@pytest.mark.parametrize("name", ["../secret.wav", "a\\b.wav", ".hidden", ""])
def test_audio_step_rejects_unsafe_file_names(name):
    with pytest.raises(ValidationError):
        Step(kind="audio", file=name)


@pytest.mark.parametrize("value", ["24:00", "9:00", "12:60", "abc"])
def test_slot_rejects_bad_time(value):
    with pytest.raises(ValidationError, match="시각"):
        Slot(name="회차", time=value, weekdays=[0], program_id="p1")


@pytest.mark.parametrize("value,expected", [("00:00", (0, 0)), ("23:59", (23, 59))])
def test_parse_hhmm_boundaries(value, expected):
    t = parse_hhmm(value)
    assert (t.hour, t.minute) == expected


def test_slot_weekdays_are_sorted_and_deduplicated():
    slot = Slot(name="회차", time="08:00", weekdays=[4, 0, 4], program_id="p1")
    assert slot.weekdays == [0, 4]


def test_slot_rejects_invalid_weekday():
    with pytest.raises(ValidationError):
        Slot(name="회차", time="08:00", weekdays=[7], program_id="p1")


def test_day_off_end_before_start_is_rejected():
    with pytest.raises(ValidationError, match="끝 날짜"):
        DayOff(start=date(2026, 12, 2), end=date(2026, 12, 1))


def test_change_override_needs_time_or_program():
    with pytest.raises(ValidationError, match="바꿀"):
        Override(date=date(2026, 11, 20), slot_id="lunch", action="change")


def test_config_rejects_slot_with_missing_program():
    cfg = make_config()
    data = cfg.model_dump()
    data["slots"][0]["program_id"] = "nope"
    with pytest.raises(ValidationError, match="방송 구성을 찾을 수 없습니다"):
        Config.model_validate(data)


def test_config_rejects_duplicate_override_for_same_day_and_slot():
    data = make_config().model_dump()
    ov = {"date": "2026-11-20", "slot_id": "lunch", "action": "skip"}
    data["overrides"] = [dict(ov, id="a"), dict(ov, id="b")]
    with pytest.raises(ValidationError, match="두 개"):
        Config.model_validate(data)


def test_program_summary_uses_labels_and_repeat():
    program = Program(
        name="점심",
        steps=[
            Step(kind="audio", file="a1b2c3d4-chime.wav", label="차임"),
            Step(kind="tts", text="안내", repeat=2),
            Step(kind="audio", file="a1b2c3d4-lunch_song.mp3"),
        ],
    )
    assert program.summary() == "차임 · 음성 ×2 · lunch_song"


def test_media_display_name_strips_storage_prefix():
    assert media_display_name("a1b2c3d4-chime.wav") == "chime.wav"
    assert media_display_name("plain.wav") == "plain.wav"
