"""실제 Windows 오디오 구현 통합 테스트. Windows에서만 돈다(CI의 windows-latest).

CI 러너에는 스피커 장치가 없을 수 있어, 장치가 필요한 테스트는 장치가 없으면 건너뛴다(사유 출력).
"""

import sys
import threading
import wave

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows 전용")


def make_wav(path, seconds=0.3):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * int(16000 * seconds))
    return path


def assert_valid_wav(path):
    with wave.open(str(path), "rb") as w:
        assert w.getnframes() > 0


def test_winrt_voices_are_listed():
    from jeongsi.audio.windows import WindowsSpeech

    voices = WindowsSpeech().voices()
    print("voices:", [(v.name, v.language) for v in voices])
    assert voices, "음성이 하나도 없습니다"


def test_korean_text_needs_korean_voice(tmp_path):
    # 한국어 음성이 있으면 소리가 나오고, 없으면 빈 소리 대신 이해할 수 있는 오류가 난다
    from jeongsi.audio.base import SpeechError
    from jeongsi.audio.windows import WindowsSpeech

    speech = WindowsSpeech()
    out = tmp_path / "tts.wav"
    if any(v.language.lower().startswith("ko") for v in speech.voices()):
        speech.synthesize("안내 방송 시험입니다.", "", 1.0, out)
        assert_valid_wav(out)
    else:
        with pytest.raises(SpeechError, match="한국어 음성"):
            speech.synthesize("안내 방송 시험입니다.", "", 1.0, out)


def test_english_text_synthesizes(tmp_path):
    from jeongsi.audio.windows import WindowsSpeech

    out = tmp_path / "en.wav"
    WindowsSpeech().synthesize("This is a broadcast test.", "", 1.0, out)
    assert_valid_wav(out)


def test_winrt_synthesize_direct_path(tmp_path):
    # SAPI 대체 경로가 아니라 WinRT 경로 자체가 동작하는지
    from jeongsi.audio.windows import WindowsSpeech, _run_async

    data = _run_async(WindowsSpeech._winrt_synthesize("test", "", 1.2))
    out = tmp_path / "winrt.wav"
    out.write_bytes(data)
    assert_valid_wav(out)


def test_sapi_synthesize_writes_wav(tmp_path):
    from jeongsi.audio.windows import WindowsSpeech

    out = tmp_path / "sapi.wav"
    WindowsSpeech._sapi_synthesize("test", "", 1.0, out)
    assert_valid_wav(out)
    assert WindowsSpeech._sapi_voices()


def no_adapter_errors(caplog):
    return [r.getMessage() for r in caplog.records if r.name == "jeongsi.audio.windows" and r.levelname == "ERROR"]


def test_media_sessions_pause_and_resume_run(caplog):
    from jeongsi.audio.windows import WindowsMediaSessions

    sessions = WindowsMediaSessions()
    paused = sessions.pause_playing()
    assert isinstance(paused, list)
    sessions.resume(paused)
    sessions.resume(sessions.pause_playing())  # 두 번째 호출도 같은 결과(스레드 문제 회귀 확인)
    assert no_adapter_errors(caplog) == []


def test_app_muter_roundtrip_runs(caplog):
    from jeongsi.audio.windows import WindowsAppMuter

    muter = WindowsAppMuter()
    keys = muter.mute_others()
    assert isinstance(keys, list)
    muter.unmute(keys)
    assert no_adapter_errors(caplog) == []


def test_muter_and_media_work_from_worker_thread(caplog):
    # 방송 실행기는 별도 스레드에서 호출한다(COM 초기화 확인)
    from jeongsi.audio.windows import WindowsAppMuter, WindowsMediaSessions

    errors = []

    def work():
        try:
            WindowsAppMuter().unmute(WindowsAppMuter().mute_others())
            WindowsMediaSessions().resume(WindowsMediaSessions().pause_playing())
        except Exception as exc:  # 스레드 예외를 테스트로 전달
            errors.append(exc)

    t = threading.Thread(target=work)
    t.start()
    t.join(30)
    assert not errors, errors
    assert no_adapter_errors(caplog) == []


def _volume_or_skip():
    from jeongsi.audio.windows import WindowsMasterVolume

    volume = WindowsMasterVolume()
    try:
        volume.get()
    except Exception as exc:
        pytest.skip(f"스피커 장치 없음: {exc!r}")
    return volume


def test_master_volume_roundtrip():
    volume = _volume_or_skip()
    level, muted = volume.get()
    volume.set(0.5, False)
    assert abs(volume.get()[0] - 0.5) < 0.02
    volume.set(level, muted)
    assert volume.get() == pytest.approx((level, muted), abs=0.02)


def test_miniaudio_duration(tmp_path):
    from jeongsi.audio.windows import MiniaudioPlayer

    assert MiniaudioPlayer().duration(make_wav(tmp_path / "a.wav", 0.5)) == pytest.approx(0.5, abs=0.05)


def test_miniaudio_play_and_interrupt(tmp_path):
    import miniaudio

    from jeongsi.audio.windows import MiniaudioPlayer

    try:
        miniaudio.PlaybackDevice().close()
    except Exception as exc:
        pytest.skip(f"재생 장치 없음: {exc!r}")
    path = make_wav(tmp_path / "b.wav", 3.0)
    interrupt = threading.Event()
    threading.Timer(0.3, interrupt.set).start()
    import time

    started = time.monotonic()
    MiniaudioPlayer().play(path, interrupt)
    assert time.monotonic() - started < 2.0


def test_full_broadcast_with_windows_backend(tmp_path):
    """실제 Windows 백엔드로 방송 하나를 끝까지 실행한다. 장치가 없으면 실패 사유가 기록에 남는다."""
    from jeongsi.audio.windows import windows_backend
    from jeongsi.history import History
    from jeongsi.models import Program, Settings, Step
    from jeongsi.runner import Job, Runner

    media = tmp_path / "media"
    media.mkdir()
    make_wav(media / "a1b2c3d4-chime.wav", 0.3)
    history = History(tmp_path / "history.jsonl")
    runner = Runner(windows_backend(), lambda: Settings(), history, media, tmp_path / "work")
    program = Program(name="시험", steps=[Step(kind="audio", file="a1b2c3d4-chime.wav"), Step(kind="tts", text="시험 방송입니다.")])
    runner._execute(Job(kind="manual", name="시험", program=program))
    entry = history.recent()[0]
    print("broadcast result:", entry.result, entry.error)
    assert not (tmp_path / "work" / "restore.json").exists()
    if entry.result == "failed":
        try:
            import miniaudio

            miniaudio.PlaybackDevice().close()
        except Exception:
            pytest.skip(f"재생 장치가 없어 재생 단계에서 실패: {entry.error}")
    assert entry.result == "done", entry.error


def test_full_broadcast_pipeline_with_real_adapters(tmp_path):
    """재생만 가짜로 두고 실제 Windows 어댑터(일시정지·음소거·음량·TTS)로 방송을 끝까지 실행한다."""
    from jeongsi.audio.fake import FakePlayer
    from jeongsi.audio.windows import windows_backend
    from jeongsi.history import History
    from jeongsi.models import Program, Settings, Step
    from jeongsi.runner import Job, Runner

    backend = windows_backend()
    backend.player = FakePlayer()
    media = tmp_path / "media"
    media.mkdir()
    make_wav(media / "a1b2c3d4-chime.wav", 0.3)
    history = History(tmp_path / "history.jsonl")
    runner = Runner(backend, lambda: Settings(), history, media, tmp_path / "work")
    program = Program(name="test", steps=[Step(kind="audio", file="a1b2c3d4-chime.wav"), Step(kind="tts", text="Broadcast test.", repeat=2)])
    runner._execute(Job(kind="manual", name="test", program=program))
    entry = history.recent()[0]
    assert entry.result == "done", entry.error
    assert backend.player.played[0] == "a1b2c3d4-chime.wav" and len(backend.player.played) == 3
    assert not (tmp_path / "work" / "restore.json").exists()
