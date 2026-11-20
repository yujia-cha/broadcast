"""소리 파일 보관함. 올린 파일은 앱 폴더로 복사해 원본을 옮겨도 동작하게 한다."""

from __future__ import annotations

import re
import threading
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import BinaryIO

from .models import is_safe_media_name, media_display_name

ALLOWED_EXTENSIONS = {".mp3", ".wav", ".flac", ".ogg"}
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
_UNSAFE_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


class MediaError(Exception):
    pass


def safe_filename(original: str) -> str:
    name = _UNSAFE_CHARS.sub("_", Path(original).name).strip(" .")
    return name[:120] or "sound"


class MediaLibrary:
    def __init__(self, directory: Path, duration: Callable[[Path], float | None]):
        self.directory = directory
        self._duration = duration
        self._cache: dict[tuple[str, float], float | None] = {}
        self._lock = threading.Lock()
        directory.mkdir(parents=True, exist_ok=True)

    def list(self) -> list[dict]:
        items = []
        for path in sorted(self.directory.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            if path.is_file() and path.suffix.lower() in ALLOWED_EXTENSIONS:
                items.append({"name": path.name, "display": media_display_name(path.name), "seconds": self.seconds(path.name)})
        return items

    def seconds(self, name: str) -> float | None:
        if not is_safe_media_name(name):
            return None
        path = self.directory / name
        if not path.exists():
            return None
        key = (name, path.stat().st_mtime)
        with self._lock:
            if key not in self._cache:
                self._cache[key] = self._duration(path)
            return self._cache[key]

    def save(self, original_name: str, stream: BinaryIO) -> str:
        filename = safe_filename(original_name)
        if Path(filename).suffix.lower() not in ALLOWED_EXTENSIONS:
            raise MediaError("mp3, wav, flac, ogg 파일만 올릴 수 있습니다.")
        stored = f"{uuid.uuid4().hex[:8]}-{filename}"
        target = self.directory / stored
        partial = target.with_name(stored + ".part")
        size = 0
        try:
            with open(partial, "wb") as out:
                while chunk := stream.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise MediaError("파일이 너무 큽니다. 200MB 이하만 올릴 수 있습니다.")
                    out.write(chunk)
            if size == 0:
                raise MediaError("빈 파일입니다.")
            partial.replace(target)
        finally:
            partial.unlink(missing_ok=True)
        if self._duration(target) is None:
            target.unlink(missing_ok=True)
            raise MediaError("재생할 수 없는 파일입니다. 다른 파일을 골라 주세요.")
        return stored

    def delete(self, name: str) -> None:
        if not is_safe_media_name(name):
            raise MediaError("파일 이름이 올바르지 않습니다.")
        (self.directory / name).unlink(missing_ok=True)
