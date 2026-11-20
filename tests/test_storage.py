import json
import pytest
from pydantic import ValidationError

from jeongsi.models import Slot
from jeongsi.storage import ConfigError, ConfigStore

from .conftest import make_config


def test_missing_file_starts_with_defaults(tmp_path):
    store = ConfigStore(tmp_path / "config.json")
    assert store.config.slots == [] and store.config.settings.volume == 70


def test_update_persists_and_reloads(tmp_path):
    # Arrange
    path = tmp_path / "config.json"
    store = ConfigStore(path)
    # Act
    store.replace(make_config())
    reloaded = ConfigStore(path)
    # Assert
    assert [s.id for s in reloaded.config.slots] == ["morning", "lunch", "home"]
    assert not (tmp_path / "config.json.tmp").exists()


def test_invalid_update_leaves_config_and_file_unchanged(tmp_path):
    path = tmp_path / "config.json"
    store = ConfigStore(path)
    store.replace(make_config())
    before = path.read_text(encoding="utf-8")

    def bad(cfg):
        cfg.slots.append(Slot(name="고아", time="09:00", weekdays=[0], program_id="없음"))

    with pytest.raises(ValidationError):
        store.update(bad)
    assert path.read_text(encoding="utf-8") == before
    assert len(store.config.slots) == 3


def test_listeners_are_notified(tmp_path):
    store = ConfigStore(tmp_path / "config.json")
    seen = []
    store.subscribe(lambda cfg: seen.append(cfg.settings.volume))
    store.update(lambda cfg: setattr(cfg.settings, "volume", 40))
    assert seen == [40]


def test_broken_file_is_moved_aside_and_defaults_used(tmp_path):
    path = tmp_path / "config.json"
    path.write_text("{ 깨진 json", encoding="utf-8")
    store = ConfigStore(path)
    assert store.config.slots == []
    assert store.load_warning
    assert list(tmp_path.glob("config.broken-*.json"))


def test_newer_schema_is_refused(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"schema_version": 99}), encoding="utf-8")
    with pytest.raises(ConfigError, match="새 버전"):
        ConfigStore(path)
