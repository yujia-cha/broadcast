"""설정 파일에 저장되는 데이터 모델과 검증 규칙.

pydantic으로 범위·형식을 검증하고, 서로 참조하는 id가 맞는지는 Config에서 확인한다.
"""

from __future__ import annotations

import re
import uuid
from datetime import date, time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SCHEMA_VERSION = 1
TIME_PATTERN = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
WEEKDAY_NAMES = ("월", "화", "수", "목", "금", "토", "일")


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def parse_hhmm(value: str) -> time:
    if not TIME_PATTERN.match(value):
        raise ValueError("시각은 00:00~23:59 형식으로 입력하세요.")
    hour, minute = value.split(":")
    return time(int(hour), int(minute))


def _check_hhmm(value: str) -> str:
    parse_hhmm(value)
    return value


def is_safe_media_name(name: str) -> bool:
    """media 폴더 안의 파일 이름만 허용한다(경로 조작 방지)."""
    return bool(name) and "/" not in name and "\\" not in name and not name.startswith(".") and ".." not in name


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True)


class Step(_Model):
    """방송 구성의 한 단계. 음성(TTS) 문구 또는 소리 파일 하나를 반복 재생한다."""

    id: str = Field(default_factory=new_id)
    kind: Literal["tts", "audio"]
    label: str = Field(default="", max_length=20)
    text: str = Field(default="", max_length=2000)
    voice: str = Field(default="", max_length=200)  # 빈 값: 설정의 기본 음성
    rate: float = Field(default=1.0, ge=0.5, le=2.0)
    file: str = Field(default="", max_length=200)  # media 폴더 안의 파일 이름
    repeat: int = Field(default=1, ge=1, le=20)
    gap_sec: float = Field(default=0, ge=0, le=60)

    @model_validator(mode="after")
    def _check_content(self) -> Step:
        if self.kind == "tts" and not self.text.strip():
            raise ValueError("음성으로 읽을 문구를 입력하세요.")
        if self.kind == "audio":
            if not self.file:
                raise ValueError("재생할 파일을 고르세요.")
            if not is_safe_media_name(self.file):
                raise ValueError("파일 이름이 올바르지 않습니다.")
        return self

    @property
    def display_label(self) -> str:
        if self.label.strip():
            return self.label.strip()
        if self.kind == "tts":
            return "음성"
        return media_display_name(self.file).rsplit(".", 1)[0]


class Program(_Model):
    """방송 구성: 순서대로 재생할 단계 목록."""

    id: str = Field(default_factory=new_id)
    name: str = Field(min_length=1, max_length=40)
    steps: list[Step] = Field(min_length=1, max_length=30)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("이름을 입력하세요.")
        return value

    def summary(self) -> str:
        parts = []
        for step in self.steps:
            part = step.display_label
            if step.repeat > 1:
                part += f" ×{step.repeat}"
            parts.append(part)
        return " · ".join(parts)


class Slot(_Model):
    """주간 일정의 회차: 정해진 요일·시각에 방송 구성 하나를 내보낸다."""

    id: str = Field(default_factory=new_id)
    name: str = Field(min_length=1, max_length=40)
    time: str
    weekdays: list[int] = Field(min_length=1, max_length=7)
    program_id: str
    enabled: bool = True

    @field_validator("time")
    @classmethod
    def _check_time(cls, value: str) -> str:
        return _check_hhmm(value)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("이름을 입력하세요.")
        return value

    @field_validator("weekdays")
    @classmethod
    def _check_weekdays(cls, value: list[int]) -> list[int]:
        if any(day < 0 or day > 6 for day in value):
            raise ValueError("요일 값이 올바르지 않습니다.")
        return sorted(set(value))


class DayOff(_Model):
    """쉬는 날: 하루(start == end) 또는 기간. 이 기간의 회차는 방송하지 않는다."""

    id: str = Field(default_factory=new_id)
    start: date
    end: date
    memo: str = Field(default="", max_length=60)

    @model_validator(mode="after")
    def _check_range(self) -> DayOff:
        if self.end < self.start:
            raise ValueError("끝 날짜가 시작 날짜보다 빠릅니다.")
        return self

    def contains(self, day: date) -> bool:
        return self.start <= day <= self.end


class Override(_Model):
    """특정 날짜의 한 회차만 쉬거나(skip) 시각·구성을 바꾼다(change)."""

    id: str = Field(default_factory=new_id)
    date: date
    slot_id: str
    action: Literal["skip", "change"]
    time: str | None = None
    program_id: str | None = None

    @field_validator("time")
    @classmethod
    def _check_time(cls, value: str | None) -> str | None:
        return None if value is None else _check_hhmm(value)

    @model_validator(mode="after")
    def _check_change(self) -> Override:
        if self.action == "change" and self.time is None and self.program_id is None:
            raise ValueError("바꿀 시각이나 방송 구성을 고르세요.")
        return self


class Settings(_Model):
    """사용자 설정. 모든 항목에 기본값이 있다."""

    auto_broadcast: bool = True
    autostart: bool = True
    close_to_tray: bool = True
    open_window_on_autostart: bool = False
    set_volume: bool = True
    volume: int = Field(default=70, ge=0, le=100)
    pause_media: bool = True
    mute_others: bool = True
    default_voice: str = Field(default="", max_length=200)
    default_rate: float = Field(default=1.0, ge=0.5, le=2.0)
    check_updates: bool = True
    theme: Literal["system", "light", "dark"] = "system"


class Config(_Model):
    schema_version: int = SCHEMA_VERSION
    programs: list[Program] = Field(default_factory=list)
    slots: list[Slot] = Field(default_factory=list)
    days_off: list[DayOff] = Field(default_factory=list)
    overrides: list[Override] = Field(default_factory=list)
    settings: Settings = Field(default_factory=Settings)

    @model_validator(mode="after")
    def _check_references(self) -> Config:
        program_ids = {p.id for p in self.programs}
        slot_ids = {s.id for s in self.slots}
        for group, ids in (("방송 구성", [p.id for p in self.programs]), ("회차", [s.id for s in self.slots])):
            if len(ids) != len(set(ids)):
                raise ValueError(f"{group} id가 중복되었습니다.")
        for slot in self.slots:
            if slot.program_id not in program_ids:
                raise ValueError(f"회차 '{slot.name}'의 방송 구성을 찾을 수 없습니다.")
        seen: set[tuple[date, str]] = set()
        for ov in self.overrides:
            if ov.slot_id not in slot_ids:
                raise ValueError("예외 일정이 없는 회차를 가리킵니다.")
            if ov.program_id is not None and ov.program_id not in program_ids:
                raise ValueError("예외 일정의 방송 구성을 찾을 수 없습니다.")
            key = (ov.date, ov.slot_id)
            if key in seen:
                raise ValueError("같은 날짜·회차에 예외 일정이 두 개 있습니다.")
            seen.add(key)
        return self

    # 조회 도우미 ---------------------------------------------------------
    def program(self, program_id: str) -> Program | None:
        return next((p for p in self.programs if p.id == program_id), None)

    def slot(self, slot_id: str) -> Slot | None:
        return next((s for s in self.slots if s.id == slot_id), None)

    def override_for(self, day: date, slot_id: str) -> Override | None:
        return next((o for o in self.overrides if o.date == day and o.slot_id == slot_id), None)

    def day_off_for(self, day: date) -> DayOff | None:
        return next((d for d in self.days_off if d.contains(day)), None)


def media_display_name(stored_name: str) -> str:
    """'a1b2c3d4-chime.wav' → 'chime.wav'."""
    head, sep, rest = stored_name.partition("-")
    if sep and len(head) == 8 and rest:
        return rest
    return stored_name
