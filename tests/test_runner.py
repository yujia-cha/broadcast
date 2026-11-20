import json
import threading
import time
from datetime import date

import pytest

from jeongsi.audio.fake import FakePlayer, FakeSpeech, fake_backend
from jeongsi.models import Program, Settings, Step
from jeongsi.runner import Job, Runner, RunnerBusy, expand_program, estimate_program_seconds


def make_runner(tmp_path, backend=None, settings=None):
    backend = backend or fake_backend()
    media = tmp_path / "media"
    media.mkdir(exist_ok=True)
    (media / "a1b2c3d4-chime.wav").write_bytes(b"")
    runner = Runner(backend, lambda: settings or Settings(), media, tmp_path / "work")
    (tmp_path / "work").mkdir(exist_ok=True)
    return runner, backend, runner


def program(repeat=2, gap=0.0):
    return Program(
        id="p1",
        name="점심 안내",
        steps=[
            Step(kind="audio", file="a1b2c3d4-chime.wav", label="차임"),
            Step(kind="tts", text="점심시간입니다.", repeat=repeat, gap_sec=gap),
        ],
    )


def job(kind="scheduled", prog=None):
    return Job(kind=kind, name="점심 안내", program=prog or program(), slot_id="lunch", date=date(2026, 11, 20))


def wait_until(predicate, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def test_broadcast_ducks_then_restores_in_reverse_order(tmp_path):
    # Arrange
    runner, backend, _ = make_runner(tmp_path)
    calls = backend.media.calls
    # Act
    runner._execute(job())
    # Assert
    assert calls == [
        ("pause",),
        ("mute",),
        ("volume", 0.7, False),
        ("volume", 0.3, True),  # 원래 음량·음소거로 복원
        ("unmute", ["chrome", "game"]),  # 이미 음소거였던 'already'는 건드리지 않음
        ("resume", ["chrome"]),
    ]
    assert runner.last_result["result"] == "done"
    assert not (tmp_path / "work" / "restore.json").exists()


def test_repeats_play_each_unit_and_tts_is_synthesized_once(tmp_path):
    runner, backend, _ = make_runner(tmp_path)
    runner._execute(job(prog=program(repeat=3)))
    assert backend.player.played[0] == "a1b2c3d4-chime.wav"
    assert len(backend.player.played) == 4
    assert len(backend.speech.requests) == 1


def test_settings_can_turn_off_each_ducking_action(tmp_path):
    settings = Settings(pause_media=False, mute_others=False, set_volume=False)
    runner, backend, _ = make_runner(tmp_path, settings=settings)
    runner._execute(job())
    assert backend.media.calls == []


def test_failure_still_restores_and_records_failed(tmp_path):
    # Arrange: 음성 합성이 실패하는 상황
    backend = fake_backend()
    backend.speech = FakeSpeech(fail=True)
    runner, backend, _ = make_runner(tmp_path, backend)
    # Act
    runner._execute(job())
    # Assert
    assert ("resume", ["chrome"]) in backend.media.calls
    last = runner.last_result
    assert last["result"] == "failed" and "음성 합성" in last["error"]


def test_missing_audio_file_fails_with_clear_message(tmp_path):
    runner, _, _ = make_runner(tmp_path)
    (tmp_path / "media" / "a1b2c3d4-chime.wav").unlink()
    runner._execute(job())
    assert "소리 파일이 없습니다" in runner.last_result["error"]


def test_preview_does_not_duck(tmp_path):
    runner, backend, _ = make_runner(tmp_path)
    runner._execute(job(kind="preview"))
    assert backend.media.calls == [] and runner.last_result["kind"] == "preview"


def test_no_history_file_is_written(tmp_path):
    # 방송 기록은 남기지 않는다(마지막 결과는 메모리에만)
    runner, _, _ = make_runner(tmp_path)
    runner._execute(job())
    assert not list(tmp_path.rglob("*history*"))
    assert runner.status()["last"]["result"] == "done"


def test_stop_ends_broadcast_restores_and_records_stopped(tmp_path):
    # Arrange: 재생이 interrupt를 기다리도록
    backend = fake_backend()
    backend.player = FakePlayer(block=True)
    runner, backend, _ = make_runner(tmp_path, backend)
    runner.start()
    try:
        runner.enqueue(job())
        assert backend.player.started.wait(2)
        # Act
        assert runner.stop_current()
        # Assert
        assert wait_until(lambda: runner.last_result)
        assert runner.last_result["result"] == "stopped"
        assert backend.player.played == ["a1b2c3d4-chime.wav"]
        assert ("resume", ["chrome"]) in backend.media.calls
        assert runner.status()["state"] == "idle"
    finally:
        runner.shutdown()


def test_skip_moves_to_next_unit(tmp_path):
    backend = fake_backend()
    backend.player = FakePlayer(block=True)
    runner, backend, _ = make_runner(tmp_path, backend)
    runner.start()
    try:
        runner.enqueue(job(prog=program(repeat=1)))
        assert wait_until(lambda: runner.status().get("index") == 0 and runner.status()["state"] == "playing")
        runner.skip_current()
        assert wait_until(lambda: runner.status().get("index") == 1)
        runner.skip_current()
        assert wait_until(lambda: runner.last_result)
        assert runner.last_result["result"] == "done"
        assert len(backend.player.played) == 2
    finally:
        runner.shutdown()


def test_stop_and_skip_when_idle_return_false(tmp_path):
    runner, _, _ = make_runner(tmp_path)
    assert runner.stop_current() is False
    assert runner.skip_current() is False


def test_preview_is_refused_while_busy(tmp_path):
    backend = fake_backend()
    backend.player = FakePlayer(block=True)
    runner, backend, _ = make_runner(tmp_path, backend)
    runner.start()
    try:
        runner.enqueue(job())
        assert backend.player.started.wait(2)
        with pytest.raises(RunnerBusy):
            runner.enqueue(job(kind="preview"))
    finally:
        runner.shutdown()


def test_jobs_run_one_after_another(tmp_path):
    runner, backend, _ = make_runner(tmp_path)
    runner.start()
    try:
        runner.enqueue(job())
        runner.enqueue(job())
        assert wait_until(lambda: backend.media.calls.count(("resume", ["chrome"])) == 2 and not runner.busy)
    finally:
        runner.shutdown()


def test_recover_restores_state_left_by_crash(tmp_path):
    # Arrange: 방송 도중 앱이 죽어 restore.json이 남은 상황
    runner, backend, _ = make_runner(tmp_path)
    restore = tmp_path / "work" / "restore.json"
    restore.write_text(json.dumps({"paused": ["chrome"], "muted": ["game"], "volume": [0.25, True]}), encoding="utf-8")
    # Act
    runner.recover()
    # Assert
    assert backend.media.calls == [("volume", 0.25, True), ("unmute", ["game"]), ("resume", ["chrome"])]
    assert not restore.exists()


def test_recover_ignores_corrupt_file(tmp_path):
    runner, backend, _ = make_runner(tmp_path)
    restore = tmp_path / "work" / "restore.json"
    restore.write_text("{깨짐", encoding="utf-8")
    runner.recover()
    assert backend.media.calls == [] and not restore.exists()


def test_expand_and_estimate_program():
    prog = program(repeat=2, gap=3)
    units = expand_program(prog, lambda name: 4.0)
    assert [u.label for u in units] == ["차임", "음성 · 반복 1/2", "음성 · 반복 2/2"]
    assert estimate_program_seconds(prog, lambda name: 4.0) == pytest.approx(4 + (8 / 7) * 2 + 3)  # 8글자 ÷ 초당 7글자


class Broken:
    def __getattr__(self, name):
        def fail(*args, **kwargs):
            raise RuntimeError(f"{name} 실패(테스트)")
        return fail


def test_ducking_failures_do_not_stop_broadcast(tmp_path):
    # Arrange: 출력 장치가 없어 음소거·음량이 실패하는 PC
    backend = fake_backend()
    backend.muter = Broken()
    backend.volume = Broken()
    runner, backend, _ = make_runner(tmp_path, backend)
    # Act
    runner._execute(job())
    # Assert: 일시정지·재생·복원은 그대로 진행
    assert runner.last_result["result"] == "done"
    assert backend.media.calls == [("pause",), ("resume", ["chrome"])]
    assert len(backend.player.played) == 3
