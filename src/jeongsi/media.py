"""소리 파일 보관함. 올린 파일은 앱 폴더로 복사해 원본을 옮겨도 동작하게 한다."""

from __future__ import annotations

import hashlib
import re
import threading
import uuid
from collections.abc import Callable
from glob import escape as glob_escape
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
    stem, suffix = Path(name).stem, Path(name).suffix[:10]
    if not stem:
        return "sound" + suffix if suffix else "sound"
    # 확장자는 지키고, 한글처럼 글자당 여러 바이트인 이름도 파일 시스템 한도(255바이트) 안에 들게 줄인다
    stem = stem[: 120 - len(suffix)]
    while len((stem + suffix).encode("utf-8")) > 180:
        stem = stem[:-1]
    return stem + suffix


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
        if not is_safe_media_name(filename):
            filename = "sound" + Path(filename).suffix
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
            if same := self._same_file(filename, partial):
                return same  # 같은 파일을 또 올리면 사본을 만들지 않는다
            partial.replace(target)
        finally:
            partial.unlink(missing_ok=True)
        if self._duration(target) is None:
            target.unlink(missing_ok=True)
            raise MediaError("재생할 수 없는 파일입니다. 다른 파일을 골라 주세요.")
        return stored

    def _same_file(self, filename: str, candidate: Path) -> str | None:
        """이름과 내용이 같은 파일이 이미 있으면 그 저장 이름."""
        size = candidate.stat().st_size
        digest = None
        for existing in self.directory.glob(f"*-{glob_escape(filename)}"):
            if existing.name.split("-", 1)[1] != filename or existing.stat().st_size != size:
                continue
            digest = digest or _sha256(candidate)
            if _sha256(existing) == digest:
                return existing.name
        return None

    def delete(self, name: str) -> None:
        if not is_safe_media_name(name):
            raise MediaError("파일 이름이 올바르지 않습니다.")
        (self.directory / name).unlink(missing_ok=True)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()
