"""Windows 오디오 구현.

- 미디어 일시정지: Windows 미디어 제어(GlobalSystemMediaTransportControls, WinRT)
- 앱별 음소거·시스템 음량: Core Audio(pycaw)
- 음성 합성: WinRT SpeechSynthesizer, 실패하면 SAPI5
- 재생: miniaudio

COM은 스레드마다 초기화해야 하므로 각 호출에서 com_thread()를 쓴다.
이 파일은 Windows에서만 import 된다. 수동 점검표는 README에 있다.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import threading
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .base import AudioBackend, SpeechError, Voice

log = logging.getLogger(__name__)
_com_local = threading.local()


def com_thread() -> None:
    """현재 스레드에서 COM을 한 번만 초기화한다."""
    if getattr(_com_local, "ready", False):
        return
    import comtypes

    comtypes.CoInitialize()
    _com_local.ready = True


_winrt_pool: ThreadPoolExecutor | None = None
_winrt_pool_lock = threading.Lock()
WINRT_TIMEOUT = 60


def _init_mta() -> None:
    import ctypes

    ctypes.windll.ole32.CoInitializeEx(None, 0)  # COINIT_MULTITHREADED


def _run_async(coro):
    """WinRT 비동기 호출을 MTA로 초기화한 전용 스레드에서 끝까지 기다린다.

    comtypes(pycaw)는 호출한 스레드를 STA로 초기화하는데, 그 스레드에서 WinRT 미디어 세션을
    다시 얻으면 RPC_E_WRONG_THREAD가 난다(Windows 러너에서 확인). WinRT는 전용 MTA 스레드에서만 부른다.
    """
    global _winrt_pool
    with _winrt_pool_lock:
        if _winrt_pool is None:
            _winrt_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="winrt", initializer=_init_mta)
    return _winrt_pool.submit(asyncio.run, coro).result(WINRT_TIMEOUT)


# ---------------------------------------------------------------- 미디어 일시정지
class WindowsMediaSessions:
    def pause_playing(self) -> list[str]:
        return _run_async(self._pause())

    def resume(self, session_ids: list[str]) -> None:
        _run_async(self._resume(set(session_ids)))

    @staticmethod
    async def _sessions():
        from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager as Manager

        manager = await Manager.request_async()
        return list(manager.get_sessions())

    async def _pause(self) -> list[str]:
        from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status

        paused = []
        for session in await self._sessions():
            try:
                if session.get_playback_info().playback_status == Status.PLAYING:
                    key = await self._session_key(session)
                    if await session.try_pause_async():
                        paused.append(key)
            except Exception:
                log.exception("미디어 세션 일시정지 실패")
        return paused

    @staticmethod
    async def _session_key(session) -> str:
        """같은 브라우저의 여러 탭을 구분하려고 앱 id와 제목을 함께 쓴다."""
        title = ""
        with contextlib.suppress(Exception):
            props = await session.try_get_media_properties_async()
            title = props.title or ""
        return f"{session.source_app_user_model_id}|{title}"

    async def _resume(self, ids: set[str]) -> None:
        from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status

        for session in await self._sessions():
            try:
                if session.get_playback_info().playback_status != Status.PAUSED:
                    continue
                if await self._session_key(session) in ids:
                    await session.try_play_async()
            except Exception:
                log.exception("미디어 세션 다시 재생 실패")


# ---------------------------------------------------------------- 앱별 음소거
class WindowsAppMuter:
    """키는 '프로세스 id:실행 파일 이름'. 이 앱 자신은 음소거하지 않는다."""

    def __init__(self) -> None:
        self._own_pid = os.getpid()

    @staticmethod
    def _key(session) -> str:
        proc = session.Process
        name = proc.name() if proc else "system"
        return f"{session.ProcessId}:{name}"

    @staticmethod
    def _sessions() -> list:
        com_thread()
        from pycaw.pycaw import AudioUtilities

        try:
            return AudioUtilities.GetAllSessions()
        except Exception as exc:  # 출력 장치가 없으면 COMError(요소를 찾을 수 없음)
            log.warning("오디오 세션을 가져오지 못했습니다(출력 장치 없음?): %r", exc)
            return []

    def mute_others(self) -> list[str]:
        newly = []
        for session in self._sessions():
            if session.ProcessId == self._own_pid:
                continue
            try:
                key = self._key(session)  # 키를 못 얻으면 음소거하지 않는다(복원할 수 없으므로)
                volume = session.SimpleAudioVolume
                if not volume.GetMute():
                    volume.SetMute(1, None)
                    newly.append(key)
            except Exception:
                log.exception("앱 음소거 실패")
        return newly

    def unmute(self, keys: list[str]) -> None:
        wanted = set(keys)
        for session in self._sessions():
            try:
                if self._key(session) in wanted:
                    session.SimpleAudioVolume.SetMute(0, None)
            except Exception:
                log.exception("앱 음소거 해제 실패")


# ---------------------------------------------------------------- 시스템 음량
class WindowsMasterVolume:
    @staticmethod
    def _endpoint():
        com_thread()
        from pycaw.pycaw import AudioUtilities

        device = AudioUtilities.GetSpeakers()
        endpoint = getattr(device, "EndpointVolume", None)  # pycaw 2024 이후
        if endpoint is not None:
            return endpoint
        from ctypes import POINTER, cast

        from comtypes import CLSCTX_ALL
        from pycaw.pycaw import IAudioEndpointVolume

        interface = device.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
        return cast(interface, POINTER(IAudioEndpointVolume))

    def get(self) -> tuple[float, bool]:
        endpoint = self._endpoint()
        return float(endpoint.GetMasterVolumeLevelScalar()), bool(endpoint.GetMute())

    def set(self, level: float, muted: bool) -> None:
        endpoint = self._endpoint()
        endpoint.SetMasterVolumeLevelScalar(max(0.0, min(1.0, level)), None)
        endpoint.SetMute(1 if muted else 0, None)


# ---------------------------------------------------------------- 음성 합성
class WindowsSpeech:
    def voices(self) -> list[Voice]:
        try:
            from winrt.windows.media.speechsynthesis import SpeechSynthesizer

            return [Voice(id=v.id, name=v.display_name, language=v.language) for v in SpeechSynthesizer.all_voices]
        except Exception:
            log.exception("WinRT 음성 목록 실패, SAPI로 대신합니다")
            return self._sapi_voices()

    def synthesize(self, text: str, voice_id: str, rate: float, out_path: Path) -> None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            data = _run_async(self._winrt_synthesize(text, voice_id, rate))
            out_path.write_bytes(data)
            if _has_audio(out_path):
                return
            log.warning("WinRT 음성이 빈 소리를 만들었습니다. SAPI로 다시 시도합니다")
        except Exception:
            log.exception("WinRT 음성 합성 실패, SAPI로 다시 시도합니다")
        try:
            self._sapi_synthesize(text, voice_id, rate, out_path)
        except Exception as exc:
            raise SpeechError(f"음성을 만들지 못했습니다: {exc}") from exc
        if not _has_audio(out_path):
            out_path.unlink(missing_ok=True)
            raise SpeechError("이 음성으로는 문구를 읽을 수 없습니다. 한국어 음성이 설치되어 있는지 확인하세요.")

    @staticmethod
    async def _winrt_synthesize(text: str, voice_id: str, rate: float) -> bytes:
        from winrt.windows.media.speechsynthesis import SpeechSynthesizer
        from winrt.windows.storage.streams import DataReader

        synth = SpeechSynthesizer()
        voices = list(SpeechSynthesizer.all_voices)
        match = next((v for v in voices if v.id == voice_id), None) if voice_id else None
        if match is None and not voice_id:
            # 기본 음성: 한국어 음성이 있으면 그것을 쓴다(영문 Windows에 한국어 음성만 추가한 경우)
            match = next((v for v in voices if v.language.lower().startswith("ko")), None)
        if match is not None:
            synth.voice = match
        synth.options.speaking_rate = rate
        stream = await synth.synthesize_text_to_stream_async(text)
        size = stream.size
        reader = DataReader(stream.get_input_stream_at(0))
        await reader.load_async(size)
        try:
            return bytes(reader.read_buffer(size))
        except TypeError:
            buf = bytearray(size)
            reader.read_bytes(buf)
            return bytes(buf)

    @staticmethod
    def _sapi_voices() -> list[Voice]:
        com_thread()
        import comtypes.client

        speaker = comtypes.client.CreateObject("SAPI.SpVoice")
        tokens = speaker.GetVoices()
        return [Voice(id=tokens.Item(i).Id, name=tokens.Item(i).GetDescription(), language="") for i in range(tokens.Count)]

    @staticmethod
    def _sapi_synthesize(text: str, voice_id: str, rate: float, out_path: Path) -> None:
        com_thread()
        import comtypes.client

        speaker = comtypes.client.CreateObject("SAPI.SpVoice")
        stream = comtypes.client.CreateObject("SAPI.SpFileStream")
        from comtypes.gen import SpeechLib  # CreateObject 이후에 생성된다

        tokens = speaker.GetVoices()
        for i in range(tokens.Count):
            token = tokens.Item(i)
            if (voice_id and token.Id == voice_id) or (not voice_id and "korean" in token.GetDescription().lower()):
                speaker.Voice = token
                break
        speaker.Rate = max(-10, min(10, round((rate - 1.0) * 10)))
        stream.Open(str(out_path), SpeechLib.SSFMCreateForWrite)
        try:
            speaker.AudioOutputStream = stream
            speaker.Speak(text)
        finally:
            stream.Close()


def _has_audio(path: Path) -> bool:
    try:
        with wave.open(str(path), "rb") as w:
            return w.getnframes() > 0
    except (wave.Error, EOFError, OSError):
        return path.exists() and path.stat().st_size > 1024  # WAV가 아닌 형식이면 크기로 판단


# ---------------------------------------------------------------- 재생
class MiniaudioPlayer:
    def play(self, path: Path, interrupt: threading.Event) -> None:
        import miniaudio

        finished = threading.Event()
        # 장치가 사라져 끝 신호가 오지 않아도 멈추지 않도록 길이 + 여유를 상한으로 둔다
        deadline = time.monotonic() + (self.duration(path) or 7200) + 5
        stream = miniaudio.stream_file(str(path))
        wrapped = miniaudio.stream_with_callbacks(stream, end_callback=finished.set)
        next(wrapped)
        with miniaudio.PlaybackDevice() as device:
            device.start(wrapped)
            while not finished.wait(0.05):
                if interrupt.is_set():
                    break
                if time.monotonic() > deadline:
                    log.warning("재생이 끝나지 않아 멈춥니다(장치 문제 가능): %s", path.name)
                    break
            else:
                interrupt.wait(0.15)  # 장치 버퍼에 남은 끝부분까지 재생

    def duration(self, path: Path) -> float | None:
        import miniaudio

        with contextlib.suppress(Exception):
            return float(miniaudio.get_file_info(str(path)).duration)
        return None


def windows_backend() -> AudioBackend:
    return AudioBackend(
        media=WindowsMediaSessions(),
        muter=WindowsAppMuter(),
        volume=WindowsMasterVolume(),
        speech=WindowsSpeech(),
        player=MiniaudioPlayer(),
        name="windows",
    )
