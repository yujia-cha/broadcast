import io
import wave
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from jeongsi.app import NullShell, Services, create_app
from jeongsi.audio.fake import FakePlayer, fake_backend
from jeongsi.history import History
from jeongsi.media import MediaLibrary
from jeongsi.runner import Runner
from jeongsi.storage import ConfigStore
from jeongsi.updater import Updater

from .conftest import make_config

NOW = datetime(2026, 11, 20, 11, 18)
HEADERS = {"X-Jeongsi-Client": "1"}


class RecordingShell(NullShell):
    def __init__(self):
        self.autostart = []

    def set_autostart(self, enabled):
        self.autostart.append(enabled)


def wav_bytes(seconds=0.5):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"\x00\x00" * int(8000 * seconds))
    return buf.getvalue()


@pytest.fixture
def env(tmp_path):
    backend = fake_backend()
    backend.player = FakePlayer(block=True)
    store = ConfigStore(tmp_path / "config.json")
    media = MediaLibrary(tmp_path / "media", backend.player.duration)
    (tmp_path / "media" / "a1b2c3d4-chime.wav").write_bytes(wav_bytes())
    store.replace(make_config())
    history = History(tmp_path / "history.jsonl")
    runner = Runner(backend, lambda: store.config.settings, history, media.directory, tmp_path / "work", now=lambda: NOW)
    runner.start()
    shell = RecordingShell()
    services = Services(
        store=store, history=history, runner=runner, updater=Updater("0.1.0", opener=_offline), audio=backend,
        media=media, data_dir=tmp_path, shell=shell, now=lambda: NOW, allowed_hosts={"testserver"},
    )
    client = TestClient(create_app(services))
    yield client, services, backend
    runner.shutdown()


def _offline(url, timeout=15.0):
    raise OSError("offline")


def test_mutating_request_without_client_header_is_refused(env):
    client, _, _ = env
    assert client.post("/api/broadcast/stop").status_code == 403


def test_unknown_host_is_refused(env):
    client, _, _ = env
    assert client.get("/api/status", headers={"host": "evil.example"}).status_code == 400


def test_status_shows_next_broadcast(env):
    client, _, _ = env
    body = client.get("/api/status").json()
    assert body["next"]["time"] == "12:00" and body["next"]["name"] == "점심 안내"
    assert body["runner"]["state"] == "idle"


def test_week_marks_past_as_missed_and_next(env):
    client, _, _ = env
    week = client.get("/api/week?start=2026-11-16").json()
    lunch = next(r for r in week["rows"] if r["slot"]["id"] == "lunch")
    friday = lunch["cells"][4]
    assert friday["status"] == "next"
    assert lunch["cells"][0]["status"] == "missed"
    assert [d["label"] for d in week["days"]] == ["월", "화", "수", "목", "금"]


def test_slot_validation_error_is_korean(env):
    client, _, _ = env
    res = client.post("/api/slots", json={"name": "회차", "time": "25:00", "weekdays": [0], "program_id": "p1"}, headers=HEADERS)
    assert res.status_code == 422
    assert "시각" in res.json()["error"]


def test_repeat_out_of_range_message(env):
    client, _, _ = env
    body = {"name": "새 구성", "steps": [{"kind": "tts", "text": "안내", "repeat": 21}]}
    res = client.post("/api/programs", json=body, headers=HEADERS)
    assert res.status_code == 422 and "반복 횟수" in res.json()["error"]


def test_create_program_and_slot(env):
    client, services, _ = env
    res = client.post("/api/programs", json={"name": "새 구성", "steps": [{"kind": "tts", "text": "안내"}]}, headers=HEADERS)
    assert res.status_code == 201
    pid = res.json()["id"]
    res = client.post("/api/slots", json={"name": "새 회차", "time": "10:00", "weekdays": [0, 2], "program_id": pid}, headers=HEADERS)
    assert res.status_code == 201
    assert services.store.config.slot(res.json()["id"]).weekdays == [0, 2]


def test_program_with_missing_file_is_rejected(env):
    client, _, _ = env
    body = {"name": "구성", "steps": [{"kind": "audio", "file": "a1b2c3d4-none.wav"}]}
    res = client.post("/api/programs", json=body, headers=HEADERS)
    assert res.status_code == 422 and "찾을 수 없습니다" in res.json()["error"]


def test_delete_program_in_use_is_refused(env):
    client, _, _ = env
    res = client.delete("/api/programs/p1", headers=HEADERS)
    assert res.status_code == 409 and "아침 조회" in res.json()["error"]


def test_delete_slot_removes_its_overrides(env):
    client, services, _ = env
    client.put("/api/overrides", json={"date": "2026-11-20", "slot_id": "lunch", "action": "skip"}, headers=HEADERS)
    assert client.delete("/api/slots/lunch", headers=HEADERS).status_code == 204
    assert services.store.config.overrides == []


def test_override_upsert_keeps_one_per_day_and_slot(env):
    client, services, _ = env
    client.put("/api/overrides", json={"date": "2026-11-20", "slot_id": "lunch", "action": "skip"}, headers=HEADERS)
    client.put("/api/overrides", json={"date": "2026-11-20", "slot_id": "lunch", "action": "change", "time": "12:30"}, headers=HEADERS)
    overrides = services.store.config.overrides
    assert len(overrides) == 1 and overrides[0].time == "12:30"
    assert client.delete("/api/overrides/2026-11-20/lunch", headers=HEADERS).status_code == 204
    assert services.store.config.overrides == []


def test_skip_next_returns_previous_for_undo(env):
    # Arrange: 오늘 점심을 12:30으로 바꿔 둔 상태
    client, services, _ = env
    client.put("/api/overrides", json={"date": "2026-11-20", "slot_id": "lunch", "action": "change", "time": "12:30"}, headers=HEADERS)
    # Act
    res = client.post("/api/skip-next", headers=HEADERS).json()
    # Assert
    assert res["slot_id"] == "lunch" and res["previous"]["time"] == "12:30"
    assert services.store.config.override_for(NOW.date(), "lunch").action == "skip"
    assert client.get("/api/status").json()["next"]["slot_id"] == "home"


def test_day_off_range_validation(env):
    client, _, _ = env
    res = client.post("/api/days-off", json={"start": "2026-12-02", "end": "2026-12-01"}, headers=HEADERS)
    assert res.status_code == 422 and "끝 날짜" in res.json()["error"]


def test_broadcast_now_then_stop(env):
    client, services, backend = env
    assert client.post("/api/broadcast", json={"program_id": "p1"}, headers=HEADERS).status_code == 202
    assert backend.player.started.wait(2)
    assert client.post("/api/broadcast", json={"program_id": "p1"}, headers=HEADERS).status_code == 409
    assert client.post("/api/broadcast/stop", headers=HEADERS).json()["stopped"] is True


def test_preview_refused_while_on_air(env):
    client, _, backend = env
    client.post("/api/broadcast", json={"program_id": "p1"}, headers=HEADERS)
    assert backend.player.started.wait(2)
    res = client.post("/api/preview", json={"kind": "tts", "text": "안내"}, headers=HEADERS)
    assert res.status_code == 409
    client.post("/api/broadcast/stop", headers=HEADERS)


def test_upload_rejects_wrong_extension(env):
    client, _, _ = env
    res = client.post("/api/media", files={"file": ("virus.exe", b"MZ", "application/octet-stream")}, headers=HEADERS)
    assert res.status_code == 422 and "mp3" in res.json()["error"]


def test_upload_sanitizes_name(env):
    client, services, _ = env
    res = client.post("/api/media", files={"file": ("../../evil name.wav", wav_bytes(), "audio/wav")}, headers=HEADERS)
    assert res.status_code == 201
    name = res.json()["name"]
    assert name.endswith("-evil name.wav") and "/" not in name
    assert (services.media.directory / name).exists()


def test_upload_rejects_unplayable_file(env):
    client, _, _ = env
    res = client.post("/api/media", files={"file": ("broken.wav", b"not audio", "audio/wav")}, headers=HEADERS)
    assert res.status_code == 422


def test_delete_media_in_use_is_refused(env):
    client, _, _ = env
    res = client.delete("/api/media/a1b2c3d4-chime.wav", headers=HEADERS)
    assert res.status_code == 409


def test_patch_settings_validates_and_calls_autostart(env):
    client, services, _ = env
    assert client.patch("/api/settings", json={"volume": 101}, headers=HEADERS).status_code == 422
    res = client.patch("/api/settings", json={"autostart": False, "volume": 50}, headers=HEADERS)
    assert res.status_code == 200
    assert services.shell.autostart == [False]
    assert services.store.config.settings.volume == 50


def test_patch_settings_rejects_unknown_field(env):
    client, _, _ = env
    assert client.patch("/api/settings", json={"hack": 1}, headers=HEADERS).status_code == 422


def test_import_rejects_broken_config(env):
    client, services, _ = env
    bad = make_config().model_dump(mode="json")
    bad["slots"][0]["program_id"] = "missing"
    assert client.post("/api/import", json=bad, headers=HEADERS).status_code == 422
    assert len(services.store.config.slots) == 3


def test_update_apply_without_release_is_refused(env):
    client, _, _ = env
    assert client.post("/api/update/apply", headers=HEADERS).status_code == 409


def test_update_check_offline_returns_502(env):
    client, _, _ = env
    assert client.post("/api/update/check", headers=HEADERS).status_code == 502
