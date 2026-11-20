"""서비스 객체를 만들고 연결한다(설정 저장소, 기록, 실행기, 스케줄러, 업데이트)."""

from __future__ import annotations

import logging
import os
import sys
import threading
from dataclasses import dataclass
from logging.handlers import RotatingFileHandler
from pathlib import Path

from . import APP_ID, __version__
from .app import Services, Shell
from .audio import default_backend
from .media import MediaLibrary
from .runner import Job, Runner
from .scheduler import Scheduler
from .storage import ConfigStore
from .updater import FEED_ENV, UpdateError, Updater

log = logging.getLogger(__name__)
UPDATE_INTERVAL_SECONDS = 24 * 60 * 60


def default_data_dir() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
        return base / APP_ID
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "jeongsi-broadcast"


def setup_logging(data_dir: Path, verbose: bool = False) -> None:
    (data_dir / "logs").mkdir(parents=True, exist_ok=True)
    handlers: list[logging.Handler] = [RotatingFileHandler(data_dir / "logs" / "app.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8")]
    if verbose or sys.stderr is not None:
        handlers.append(logging.StreamHandler())
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", handlers=handlers, force=True)


@dataclass
class Application:
    services: Services
    scheduler: Scheduler
    _update_stop: threading.Event

    def start(self) -> None:
        self.services.runner.start()
        self.scheduler.start()
        threading.Thread(target=self._update_loop, name="update-check", daemon=True).start()

    def stop(self) -> None:
        self._update_stop.set()
        self.scheduler.stop()
        self.services.runner.shutdown()

    def _update_loop(self) -> None:
        """시작할 때 한 번, 이후 하루마다 새 버전을 확인한다(설정에서 끌 수 있음)."""
        while not self._update_stop.is_set():
            if self.services.store.config.settings.check_updates:
                try:
                    self.services.updater.check()
                except UpdateError as exc:
                    log.info("업데이트 확인 실패: %s", exc)
            self._update_stop.wait(UPDATE_INTERVAL_SECONDS)


def build_application(data_dir: Path, port: int, shell: Shell, use_fake_audio: bool = False) -> Application:
    data_dir.mkdir(parents=True, exist_ok=True)
    audio = default_backend(use_fake=use_fake_audio)
    store = ConfigStore(data_dir / "config.json")
    media = MediaLibrary(data_dir / "media", audio.player.duration)
    runner = Runner(audio, lambda: store.config.settings, media.directory, data_dir / "work")
    updater = Updater(__version__, feed_url=os.environ.get(FEED_ENV) or None)
    services = Services(
        store=store,
        runner=runner,
        updater=updater,
        audio=audio,
        media=media,
        data_dir=data_dir,
        shell=shell,
        allowed_hosts={f"127.0.0.1:{port}", f"localhost:{port}"},
    )
    scheduler = Scheduler(store, runner.enqueue, state_path=data_dir / "work" / "scheduler.json")
    return Application(services=services, scheduler=scheduler, _update_stop=threading.Event())


__all__ = ["Application", "Job", "build_application", "default_data_dir", "setup_logging"]
