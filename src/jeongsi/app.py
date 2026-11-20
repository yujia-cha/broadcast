"""로컬 웹 API(FastAPI)와 화면 파일 제공.

보안: 127.0.0.1에만 바인딩하고, Host 헤더를 확인해 DNS 리바인딩을 막으며,
값을 바꾸는 요청에는 X-Jeongsi-Client 헤더를 요구해 다른 웹사이트가 로컬 API를 호출하지 못하게 한다
(브라우저는 교차 출처 요청에 사용자 지정 헤더를 붙이려면 CORS 사전 요청을 보내고, 이 서버는 허용하지 않는다).
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, Protocol

from fastapi import Body, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from . import APP_ID, __version__
from .audio.base import AudioBackend, Voice
from .history import History
from .media import MediaError, MediaLibrary
from .models import Config, DayOff, Override, Program, Settings, Slot, Step
from .runner import Job, Runner, RunnerBusy
from .schedule import next_occurrence
from .storage import ConfigError, ConfigStore
from .timetable import build_week, describe_next, week_start
from .updater import UpdateError, Updater, apply_update

log = logging.getLogger(__name__)
STATIC_DIR = Path(__file__).parent / "static"
CLIENT_HEADER = "x-jeongsi-client"


class Shell(Protocol):
    """데스크톱 환경에 따라 달라지는 동작(창, 트레이, 자동 실행, exe 경로)."""

    def show_window(self) -> None: ...
    def open_folder(self, path: Path) -> None: ...
    def set_autostart(self, enabled: bool) -> None: ...
    def exe_path(self) -> Path | None: ...
    def request_exit(self) -> None: ...


class NullShell:
    def show_window(self) -> None:
        pass

    def open_folder(self, path: Path) -> None:
        pass

    def set_autostart(self, enabled: bool) -> None:
        pass

    def exe_path(self) -> Path | None:
        return None

    def request_exit(self) -> None:
        pass


@dataclass
class Services:
    store: ConfigStore
    history: History
    runner: Runner
    updater: Updater
    audio: AudioBackend
    media: MediaLibrary
    data_dir: Path
    shell: Shell = field(default_factory=NullShell)
    now: Callable[[], datetime] = datetime.now
    allowed_hosts: set[str] = field(default_factory=set)
    _voices: list[Voice] | None = None

    def voices(self) -> list[Voice]:
        if self._voices is None:
            try:
                self._voices = self.audio.speech.voices()
            except Exception:
                log.exception("음성 목록을 가져오지 못했습니다")
                self._voices = []
        return self._voices


# 오류 메시지 -------------------------------------------------------------------
_FIELD_NAMES = {
    "name": "이름", "time": "시각", "weekdays": "요일", "program_id": "방송 구성", "steps": "단계",
    "repeat": "반복 횟수", "gap_sec": "반복 사이 간격", "rate": "속도", "text": "문구", "file": "파일",
    "volume": "방송 음량", "start": "시작 날짜", "end": "끝 날짜", "memo": "메모", "date": "날짜",
    "label": "단계 이름", "default_rate": "기본 속도",
}


def _korean_error(err: dict) -> str:
    kind, ctx = err.get("type", ""), err.get("ctx") or {}
    fields = [str(p) for p in err.get("loc", ()) if isinstance(p, str) and p not in ("body",)]
    label = _FIELD_NAMES.get(fields[-1], fields[-1]) if fields else "값"
    if kind == "value_error":
        return str(ctx.get("error", err.get("msg", "")))
    if kind in ("greater_than_equal", "greater_than"):
        return f"{label}은(는) {ctx.get('ge', ctx.get('gt'))} 이상이어야 합니다."
    if kind in ("less_than_equal", "less_than"):
        return f"{label}은(는) {ctx.get('le', ctx.get('lt'))} 이하여야 합니다."
    if kind == "string_too_long":
        return f"{label}은(는) {ctx.get('max_length')}자 이하로 입력하세요."
    if kind in ("string_too_short", "too_short"):
        return f"{label}을(를) 입력하세요."
    if kind == "too_long":
        return f"{label}이(가) 너무 많습니다."
    if kind == "missing":
        return f"{label}을(를) 입력하세요."
    if kind == "extra_forbidden":
        return f"알 수 없는 항목입니다: {label}"
    return f"{label}이(가) 올바르지 않습니다."


def _validation_response(exc: ValidationError) -> JSONResponse:
    errors = exc.errors()
    messages = [_korean_error(e) for e in errors]
    fields = [".".join(str(p) for p in e.get("loc", ())) for e in errors]
    return JSONResponse(status_code=422, content={"error": messages[0] if messages else "입력이 올바르지 않습니다.", "fields": fields, "messages": messages})


def _bad(status: int, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail=message)


# 앱 ----------------------------------------------------------------------------
def create_app(services: Services) -> FastAPI:
    app = FastAPI(title=APP_ID, docs_url=None, redoc_url=None, openapi_url=None)
    s = services

    @app.middleware("http")
    async def guard(request: Request, call_next):
        host = request.headers.get("host", "")
        if s.allowed_hosts and host not in s.allowed_hosts:
            return JSONResponse(status_code=400, content={"error": "허용하지 않는 주소입니다."})
        if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get(CLIENT_HEADER) != "1":
            return JSONResponse(status_code=403, content={"error": "허용하지 않는 요청입니다."})
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(ValidationError)
    async def _on_validation(_: Request, exc: ValidationError):
        return _validation_response(exc)

    @app.exception_handler(RequestValidationError)
    async def _on_request_validation(_: Request, exc: RequestValidationError):
        messages = [_korean_error(dict(e)) for e in exc.errors()]
        return JSONResponse(status_code=422, content={"error": messages[0] if messages else "입력이 올바르지 않습니다.", "messages": messages})

    @app.exception_handler(HTTPException)
    async def _on_http(_: Request, exc: HTTPException):
        return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})

    @app.exception_handler(ConfigError)
    async def _on_config(_: Request, exc: ConfigError):
        return JSONResponse(status_code=500, content={"error": str(exc)})

    def cfg() -> Config:
        return s.store.config

    def update(mutate: Callable[[Config], Any]) -> Config:
        return s.store.update(mutate)

    # 상태 ------------------------------------------------------------------
    @app.get("/api/ping")
    def ping():
        return {"app": APP_ID, "version": __version__}

    @app.get("/api/status")
    def status():
        now = s.now()
        config = cfg()
        runner = s.runner.status()
        if runner.get("program_id"):
            program = config.program(runner["program_id"])
            runner["summary"] = program.summary() if program else ""
        return {
            "now": now.isoformat(timespec="seconds"),
            "version": __version__,
            "auto_broadcast": config.settings.auto_broadcast,
            "runner": runner,
            "next": describe_next(config, now, s.media.seconds),
            "update": s.updater.status(),
            "warning": s.store.load_warning,
            "voices_ok": any(_is_korean(v) for v in s.voices()),
            "theme": config.settings.theme,
            "has_programs": bool(config.programs),
            "can_update": s.shell.exe_path() is not None,
        }

    @app.get("/api/week")
    def week(start: date | None = None):
        now = s.now()
        runner = s.runner.status()
        live = None
        if runner.get("kind") == "scheduled" and runner.get("slot_id") and runner.get("date"):
            live = (date.fromisoformat(runner["date"]), runner["slot_id"])
        return build_week(cfg(), start or week_start(now.date()), now, s.history.results_by_occurrence(), live)

    # 방송 구성 ---------------------------------------------------------------
    def program_view(p: Program, config: Config) -> dict:
        from .runner import estimate_program_seconds

        return {
            **p.model_dump(mode="json"),
            "summary": p.summary(),
            "seconds": round(estimate_program_seconds(p, s.media.seconds)),
            "used_by": [sl.name for sl in config.slots if sl.program_id == p.id],
        }

    @app.get("/api/programs")
    def list_programs():
        config = cfg()
        return [program_view(p, config) for p in config.programs]

    @app.post("/api/programs", status_code=201)
    def create_program(body: dict = Body(...)):
        body.pop("id", None)
        program = Program.model_validate(body)
        _check_files_exist(program)
        config = update(lambda c: c.programs.append(program))
        return program_view(program, config)

    @app.put("/api/programs/{program_id}")
    def save_program(program_id: str, body: dict = Body(...)):
        program = Program.model_validate({**body, "id": program_id})
        _check_files_exist(program)

        def mutate(c: Config):
            idx = _index(c.programs, program_id, "방송 구성")
            c.programs[idx] = program

        config = update(mutate)
        return program_view(program, config)

    @app.delete("/api/programs/{program_id}", status_code=204)
    def delete_program(program_id: str):
        config = cfg()
        users = [sl.name for sl in config.slots if sl.program_id == program_id]
        users += [f"{o.date} 예외" for o in config.overrides if o.program_id == program_id]
        if users:
            raise _bad(409, f"이 방송 구성을 쓰는 회차가 있어 지울 수 없습니다: {', '.join(users)}")
        update(lambda c: c.programs.pop(_index(c.programs, program_id, "방송 구성")))
        return Response(status_code=204)

    def _check_files_exist(program: Program) -> None:
        for step in program.steps:
            if step.kind == "audio" and s.media.seconds(step.file) is None:
                raise _bad(422, f"소리 파일을 찾을 수 없습니다: {step.display_label}")

    # 회차 ------------------------------------------------------------------
    @app.post("/api/slots", status_code=201)
    def create_slot(body: dict = Body(...)):
        body.pop("id", None)
        slot = Slot.model_validate(body)
        update(lambda c: c.slots.append(slot))
        return slot.model_dump(mode="json")

    @app.put("/api/slots/{slot_id}")
    def save_slot(slot_id: str, body: dict = Body(...)):
        slot = Slot.model_validate({**body, "id": slot_id})

        def mutate(c: Config):
            c.slots[_index(c.slots, slot_id, "회차")] = slot

        update(mutate)
        return slot.model_dump(mode="json")

    @app.delete("/api/slots/{slot_id}", status_code=204)
    def delete_slot(slot_id: str):
        def mutate(c: Config):
            c.slots.pop(_index(c.slots, slot_id, "회차"))
            c.overrides = [o for o in c.overrides if o.slot_id != slot_id]

        update(mutate)
        return Response(status_code=204)

    # 쉬는 날·예외 -------------------------------------------------------------
    @app.post("/api/days-off", status_code=201)
    def add_day_off(body: dict = Body(...)):
        body.pop("id", None)
        day_off = DayOff.model_validate(body)
        update(lambda c: c.days_off.append(day_off))
        return day_off.model_dump(mode="json")

    @app.delete("/api/days-off/{day_off_id}", status_code=204)
    def delete_day_off(day_off_id: str):
        update(lambda c: c.days_off.pop(_index(c.days_off, day_off_id, "쉬는 날")))
        return Response(status_code=204)

    @app.get("/api/days-off")
    def list_days_off():
        return [d.model_dump(mode="json") for d in sorted(cfg().days_off, key=lambda d: d.start)]

    @app.put("/api/overrides")
    def put_override(body: dict = Body(...)):
        body.pop("id", None)
        override = Override.model_validate(body)

        def mutate(c: Config):
            c.overrides = [o for o in c.overrides if not (o.date == override.date and o.slot_id == override.slot_id)]
            c.overrides.append(override)

        update(mutate)
        return override.model_dump(mode="json")

    @app.delete("/api/overrides/{day}/{slot_id}", status_code=204)
    def delete_override(day: date, slot_id: str):
        update(lambda c: setattr(c, "overrides", [o for o in c.overrides if not (o.date == day and o.slot_id == slot_id)]))
        return Response(status_code=204)

    @app.post("/api/skip-next")
    def skip_next():
        """오늘(또는 가장 가까운) 다음 방송 하나만 끈다. 되돌리기용으로 이전 예외를 돌려준다."""
        config = cfg()
        occ = next_occurrence(config, s.now())
        if occ is None:
            raise _bad(404, "끌 방송이 없습니다.")
        previous = config.override_for(occ.date, occ.slot_id)
        put_override({"date": occ.date.isoformat(), "slot_id": occ.slot_id, "action": "skip"})
        return {
            "date": occ.date.isoformat(),
            "slot_id": occ.slot_id,
            "name": occ.name,
            "time": occ.time.strftime("%H:%M"),
            "previous": previous.model_dump(mode="json") if previous else None,
        }

    # 방송 제어 ----------------------------------------------------------------
    @app.post("/api/broadcast", status_code=202)
    def broadcast_now(body: dict = Body(...)):
        program = cfg().program(str(body.get("program_id", "")))
        if program is None:
            raise _bad(404, "방송 구성을 찾을 수 없습니다.")
        if s.runner.on_air:
            raise _bad(409, "이미 방송 중입니다.")
        s.runner.enqueue(Job(kind="manual", name=program.name, program=program))
        return {"ok": True}

    @app.post("/api/broadcast/stop")
    def broadcast_stop():
        return {"stopped": s.runner.stop_current()}

    @app.post("/api/broadcast/skip")
    def broadcast_skip():
        return {"skipped": s.runner.skip_current()}

    @app.post("/api/preview", status_code=202)
    def preview(body: dict = Body(...)):
        step = Step.model_validate({**body, "repeat": 1, "gap_sec": 0})
        if step.kind == "audio" and s.media.seconds(step.file) is None:
            raise _bad(422, "소리 파일을 찾을 수 없습니다.")
        program = Program(name="미리듣기", steps=[step])
        try:
            s.runner.enqueue(Job(kind="preview", name="미리듣기", program=program))
        except RunnerBusy as exc:
            raise _bad(409, str(exc)) from exc
        return {"ok": True}

    # 소리 파일·음성 -------------------------------------------------------------
    @app.get("/api/media")
    def list_media():
        return s.media.list()

    @app.post("/api/media", status_code=201)
    def upload_media(file: UploadFile = File(...)):
        try:
            name = s.media.save(file.filename or "sound", file.file)
        except MediaError as exc:
            raise _bad(422, str(exc)) from exc
        return next(m for m in s.media.list() if m["name"] == name)

    @app.delete("/api/media/{name}", status_code=204)
    def delete_media(name: str):
        users = [p.name for p in cfg().programs if any(st.kind == "audio" and st.file == name for st in p.steps)]
        if users:
            raise _bad(409, f"이 파일을 쓰는 방송 구성이 있습니다: {', '.join(users)}")
        try:
            s.media.delete(name)
        except MediaError as exc:
            raise _bad(422, str(exc)) from exc
        return Response(status_code=204)

    @app.get("/api/voices")
    def voices():
        return [{"id": v.id, "name": v.name, "language": v.language, "korean": _is_korean(v)} for v in s.voices()]

    # 기록 ------------------------------------------------------------------
    @app.get("/api/history")
    def history(limit: int = 200):
        limit = max(1, min(limit, 1000))
        return [e.model_dump(mode="json") for e in s.history.recent(limit)]

    # 설정 ------------------------------------------------------------------
    @app.get("/api/settings")
    def get_settings():
        return cfg().settings.model_dump(mode="json")

    @app.patch("/api/settings")
    def patch_settings(body: dict = Body(...)):
        current = cfg().settings
        new = Settings.model_validate({**current.model_dump(), **body})
        if new.autostart != current.autostart:
            try:
                s.shell.set_autostart(new.autostart)
            except OSError as exc:
                raise _bad(500, f"자동 실행 설정을 바꾸지 못했습니다: {exc}") from exc
        update(lambda c: setattr(c, "settings", new))
        return new.model_dump(mode="json")

    @app.post("/api/settings/reset")
    def reset_settings():
        return patch_settings(Settings().model_dump(mode="json"))

    @app.get("/api/export")
    def export_config():
        return Response(
            content=cfg().model_dump_json(indent=2),
            media_type="application/json",
            headers={"Content-Disposition": 'attachment; filename="jeongsi-config.json"'},
        )

    @app.post("/api/import")
    def import_config(body: dict = Body(...)):
        config = Config.model_validate(body)
        s.store.replace(config)
        return {"ok": True}

    @app.post("/api/open-data-folder")
    def open_data_folder():
        s.shell.open_folder(s.data_dir)
        return {"ok": True}

    @app.post("/api/window/show")
    def show_window():
        s.shell.show_window()
        return {"ok": True}

    # 업데이트 ----------------------------------------------------------------
    @app.post("/api/update/check")
    def update_check():
        try:
            s.updater.check()
        except UpdateError as exc:
            raise _bad(502, "업데이트를 확인하지 못했습니다. 인터넷 연결을 확인하세요.") from exc
        return s.updater.status()

    @app.post("/api/update/apply", status_code=202)
    def update_apply():
        status_ = s.updater.status()
        if "release" not in status_:
            raise _bad(409, "설치할 새 버전이 없습니다.")
        if s.runner.on_air:
            raise _bad(409, "방송 중에는 업데이트할 수 없습니다. 방송이 끝난 뒤 다시 시도하세요.")
        exe = s.shell.exe_path()
        if exe is None:
            raise _bad(409, "개발 모드에서는 업데이트를 적용할 수 없습니다.")
        from .updater import ReleaseInfo

        release = ReleaseInfo(**status_["release"])

        def work():
            try:
                # exe와 같은 폴더에 받아야 같은 드라이브 안에서 바로 바꿀 수 있고, 쓰기 권한도 미리 확인된다
                new_file = s.updater.download(release, exe.parent)
                apply_update(new_file, exe)
                s.shell.request_exit()
            except UpdateError as exc:
                log.error("업데이트 실패: %s", exc)
                s.updater.mark_error(str(exc))

        threading.Thread(target=work, name="update", daemon=True).start()
        return {"ok": True}

    # 화면 ------------------------------------------------------------------
    if STATIC_DIR.exists():
        app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

        @app.get("/")
        def index():
            return FileResponse(STATIC_DIR / "index.html")

    return app


def _index(items: list, item_id: str, label: str) -> int:
    for i, item in enumerate(items):
        if item.id == item_id:
            return i
    raise _bad(404, f"{label}을(를) 찾을 수 없습니다.")


def _is_korean(voice: Voice) -> bool:
    text = f"{voice.language} {voice.name}".lower()
    return "ko" in voice.language.lower() or "korean" in text or "한국어" in text
