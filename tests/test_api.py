import io
import wave
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from jeongsi.app import NullShell, Services, create_app
from jeongsi.audio.fake import FakePlayer, fake_backend
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
    runner = Runner(backend, lambda: store.config.settings, media.directory, tmp_path / "work", now=lambda: NOW)
    runner.start()
    shell = RecordingShell()
    services = Services(
        store=store, runner=runner, updater=Updater("0.1.0", opener=_offline), audio=backend,
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
    assert lunch["cells"][0]["status"] == "past"
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


def test_upload_same_file_twice_reuses_it(env):
    # Arrange
    client, services, _ = env
    data = wav_bytes()
    first = client.post("/api/media", files={"file": ("bell.wav", data, "audio/wav")}, headers=HEADERS).json()["name"]
    # Act
    second = client.post("/api/media", files={"file": ("bell.wav", data, "audio/wav")}, headers=HEADERS)
    # Assert
    assert second.status_code == 201 and second.json()["name"] == first
    assert len(list(services.media.directory.glob("*-bell.wav"))) == 1


def test_upload_same_name_different_content_is_kept_separately(env):
    client, services, _ = env
    client.post("/api/media", files={"file": ("bell.wav", wav_bytes(0.5), "audio/wav")}, headers=HEADERS)
    client.post("/api/media", files={"file": ("bell.wav", wav_bytes(0.25), "audio/wav")}, headers=HEADERS)
    assert len(list(services.media.directory.glob("*-bell.wav"))) == 2
    assert not list(services.media.directory.glob("*.part"))


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


def test_preview_whole_program(env):
    client, _, backend = env
    body = {"name": "", "steps": [{"kind": "audio", "file": "a1b2c3d4-chime.wav"}, {"kind": "tts", "text": "안내", "repeat": 2}]}
    assert client.post("/api/preview", json=body, headers=HEADERS).status_code == 202
    assert backend.player.started.wait(2)
    assert backend.media.calls == []  # 미리듣기는 다른 소리를 건드리지 않는다
    client.post("/api/broadcast/stop", headers=HEADERS)


def test_preview_program_with_missing_file_is_rejected(env):
    client, _, _ = env
    body = {"steps": [{"kind": "audio", "file": "a1b2c3d4-gone.wav"}]}
    res = client.post("/api/preview", json=body, headers=HEADERS)
    assert res.status_code == 422 and "찾을 수 없습니다" in res.json()["error"]


def test_history_api_is_gone(env):
    client, _, _ = env
    assert client.get("/api/history").status_code == 404


def test_failure_is_reported_in_status_not_stored(env, tmp_path):
    client, services, backend = env
    backend.player.block = False
    (services.media.directory / "a1b2c3d4-chime.wav").unlink()
    client.post("/api/broadcast", json={"program_id": "p1"}, headers=HEADERS)
    import time
    for _ in range(100):
        last = client.get("/api/status").json()["runner"]["last"]
        if last:
            break
        time.sleep(0.02)
    assert last["result"] == "failed" and "소리 파일이 없습니다" in last["error"]
    assert not list(tmp_path.rglob("*history*"))


def test_import_rejects_newer_schema(env):
    client, services, _ = env
    data = make_config().model_dump(mode="json")
    data["schema_version"] = 99
    res = client.post("/api/import", json=data, headers=HEADERS)
    assert res.status_code == 422 and "새 버전" in res.json()["error"]


def test_reset_settings_keeps_auto_broadcast(env):
    client, services, _ = env
    client.patch("/api/settings", json={"auto_broadcast": False, "volume": 30}, headers=HEADERS)
    client.post("/api/settings/reset", headers=HEADERS)
    settings = services.store.config.settings
    assert settings.auto_broadcast is False and settings.volume == 70


def test_stop_preview_does_not_stop_broadcast(env):
    client, _, backend = env
    client.post("/api/broadcast", json={"program_id": "p1"}, headers=HEADERS)
    assert backend.player.started.wait(2)
    assert client.post("/api/broadcast/stop", json={"kind": "preview"}, headers=HEADERS).json()["stopped"] is False
    assert client.post("/api/broadcast/stop", headers=HEADERS).json()["stopped"] is True


def test_update_apply_twice_is_refused(env):
    client, services, _ = env
    services.updater._release = __import__("jeongsi.updater", fromlist=["ReleaseInfo"]).ReleaseInfo("9.0.0", "", "", "", "a", "b")
    services.updater.mark_downloading()
    res = client.post("/api/update/apply", headers=HEADERS)
    assert res.status_code == 409 and "진행" in res.json()["error"]


def test_create_broadcast_makes_program_and_slot(env):
    # Arrange
    client, services, _ = env
    body = {
        "name": "하교 음악",
        "steps": [{"kind": "tts", "text": "하교 시간입니다.", "repeat": 2}, {"kind": "audio", "file": "a1b2c3d4-chime.wav"}],
        "time": "16:30", "weekdays": [0, 1, 2, 3, 4], "start_date": "2026-11-23",
    }
    # Act
    res = client.post("/api/broadcasts", json=body, headers=HEADERS)
    # Assert
    assert res.status_code == 201
    data = res.json()
    assert data["next"] == {"date": "2026-11-23", "time": "16:30"}
    cfg = services.store.config
    slot = cfg.slot(data["slot"]["id"])
    assert slot.program_id == data["program"]["id"] and cfg.program(slot.program_id).steps[0].repeat == 2


@pytest.mark.parametrize("bad", [
    {"time": "25:00"},
    {"weekdays": []},
    {"steps": []},
    {"name": " "},
    {"end_date": "2026-11-01", "start_date": "2026-11-30"},
])
def test_create_broadcast_is_all_or_nothing(env, bad):
    client, services, _ = env
    body = {"name": "새 방송", "steps": [{"kind": "tts", "text": "안내"}], "time": "09:00", "weekdays": [0], **bad}
    before = (len(services.store.config.programs), len(services.store.config.slots))
    res = client.post("/api/broadcasts", json=body, headers=HEADERS)
    assert res.status_code == 422
    assert (len(services.store.config.programs), len(services.store.config.slots)) == before


def test_create_broadcast_on_specific_dates(env):
    client, services, _ = env
    body = {"name": "행사 안내", "steps": [{"kind": "tts", "text": "행사가 곧 시작합니다."}], "time": "10:00", "dates": ["2026-11-21", "2026-11-28"]}
    res = client.post("/api/broadcasts", json=body, headers=HEADERS)
    assert res.status_code == 201
    assert res.json()["next"] == {"date": "2026-11-21", "time": "10:00"}
    week = client.get("/api/week?start=2026-11-16").json()
    assert [d["label"] for d in week["days"]][-1] == "토"


def test_check_broadcast_marks_past_and_day_off_dates(env):
    # Arrange: NOW = 2026-11-20 11:18, 11/25을 쉬는 날로
    client, _, _ = env
    client.post("/api/days-off", json={"start": "2026-11-25", "end": "2026-11-25", "memo": "행사"}, headers=HEADERS)
    body = {"time": "09:00", "dates": ["2026-11-25", "2026-11-20", "2026-11-21"]}
    # Act
    res = client.post("/api/broadcasts/check", json=body, headers=HEADERS)
    # Assert
    assert res.status_code == 200
    assert res.json()["dates"] == [
        {"date": "2026-11-20", "state": "past"},
        {"date": "2026-11-21", "state": "ok"},
        {"date": "2026-11-25", "state": "off"},
    ]


def test_check_broadcast_today_later_time_is_ok(env):
    client, _, _ = env
    res = client.post("/api/broadcasts/check", json={"time": "11:19", "dates": ["2026-11-20"]}, headers=HEADERS)
    assert res.json()["dates"] == [{"date": "2026-11-20", "state": "ok"}]


def test_create_broadcast_refuses_dates_that_never_air(env):
    # Arrange: 오늘 지난 시각 + 쉬는 날만 고름
    client, services, _ = env
    client.post("/api/days-off", json={"start": "2026-11-25", "end": "2026-11-25"}, headers=HEADERS)
    body = {"name": "행사", "steps": [{"kind": "tts", "text": "안내"}], "time": "09:00", "dates": ["2026-11-20", "2026-11-25"]}
    before = len(services.store.config.slots)
    # Act
    res = client.post("/api/broadcasts", json=body, headers=HEADERS)
    # Assert
    assert res.status_code == 422 and "나갈 방송이 없습니다" in res.json()["error"]
    assert len(services.store.config.slots) == before


def test_day_off_already_covered_is_refused(env):
    # Arrange: 11/23~11/27 쉬는 날
    client, services, _ = env
    client.post("/api/days-off", json={"start": "2026-11-23", "end": "2026-11-27"}, headers=HEADERS)
    # Act: 같은 기간, 안에 든 하루
    same = client.post("/api/days-off", json={"start": "2026-11-23", "end": "2026-11-27"}, headers=HEADERS)
    inside = client.post("/api/days-off", json={"start": "2026-11-25", "end": "2026-11-25"}, headers=HEADERS)
    wider = client.post("/api/days-off", json={"start": "2026-11-27", "end": "2026-11-28"}, headers=HEADERS)
    # Assert: 겹치기만 하면 허용(새 날이 늘어남)
    assert same.status_code == 409 and "이미 쉬는 날" in same.json()["error"]
    assert inside.status_code == 409
    assert wider.status_code == 201
    assert len(services.store.config.days_off) == 2
