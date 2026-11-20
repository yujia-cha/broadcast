"""설정 파일(config.json) 읽기·쓰기.

- 임시 파일에 쓴 뒤 교체해서, 저장 도중 꺼져도 파일이 깨지지 않게 한다.
- 읽을 수 없는 파일은 지우지 않고 config.broken-<시각>.json으로 옮긴 뒤 빈 설정으로 시작한다.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

from pydantic import ValidationError

from .models import SCHEMA_VERSION, Config

log = logging.getLogger(__name__)


class ConfigError(Exception):
    """설정 파일을 쓸 수 없거나 이 버전이 읽을 수 없는 형식일 때."""


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def migrate(raw: dict) -> dict:
    """이전 형식의 설정을 현재 형식으로 바꾼다. 현재는 v1뿐이다."""
    version = raw.get("schema_version", 1)
    if version > SCHEMA_VERSION:
        raise ConfigError("새 버전의 앱에서 만든 설정 파일입니다. 앱을 최신 버전으로 업데이트하세요.")
    raw["schema_version"] = SCHEMA_VERSION
    return raw


class ConfigStore:
    def __init__(self, path: Path):
        self._path = path
        self._lock = threading.RLock()
        self._listeners: list[Callable[[Config], None]] = []
        self.load_warning: str | None = None
        self._config = self._load()

    @property
    def path(self) -> Path:
        return self._path

    @property
    def config(self) -> Config:
        """현재 설정. 바꿀 때는 update()를 쓴다."""
        with self._lock:
            return self._config

    def subscribe(self, listener: Callable[[Config], None]) -> None:
        self._listeners.append(listener)

    def update(self, mutate: Callable[[Config], None]) -> Config:
        """복사본을 바꾸고 전체를 다시 검증한 뒤 저장한다. 검증 실패 시 아무것도 바뀌지 않는다."""
        with self._lock:
            draft = self._config.model_copy(deep=True)
            mutate(draft)
            validated = Config.model_validate(draft.model_dump())
            self._save(validated)
            self._config = validated
        for listener in list(self._listeners):
            try:
                listener(validated)
            except Exception:  # 알림 실패가 저장을 되돌리지는 않는다
                log.exception("설정 변경 알림 실패")
        return validated

    def replace(self, config: Config) -> Config:
        return self.update(lambda draft: _copy_into(draft, config))

    # 내부 ------------------------------------------------------------------
    def _load(self) -> Config:
        if not self._path.exists():
            return Config()
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            return Config.model_validate(migrate(raw))
        except ConfigError:
            raise
        except (OSError, ValueError, ValidationError) as exc:
            backup = self._path.with_name(f"config.broken-{datetime.now():%Y%m%d-%H%M%S}.json")
            try:
                os.replace(self._path, backup)
            except OSError:
                log.exception("깨진 설정 파일을 옮기지 못했습니다")
                raise ConfigError(f"설정 파일을 읽을 수 없습니다: {exc}") from exc
            log.warning("설정 파일을 읽을 수 없어 %s로 옮겼습니다: %s", backup.name, exc)
            self.load_warning = f"설정 파일을 읽을 수 없어 {backup.name}로 옮기고 빈 설정으로 시작했습니다."
            return Config()

    def _save(self, config: Config) -> None:
        try:
            atomic_write_text(self._path, config.model_dump_json(indent=2))
        except OSError as exc:
            raise ConfigError(f"설정을 저장하지 못했습니다: {exc}") from exc


def _copy_into(draft: Config, source: Config) -> None:
    for field in Config.model_fields:
        setattr(draft, field, getattr(source, field))
