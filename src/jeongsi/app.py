"""로컬 웹 API(FastAPI)와 화면 파일 제공.

보안: 127.0.0.1에만 바인딩하고, Host 헤더를 확인해 DNS 리바인딩을 막으며,
값을 바꾸는 요청에는 X-Jeongsi-Client 헤더를 요구해 다른 웹사이트가 로컬 API를 호출하지 못하게 한다
(브라우저는 교차 출처 요청에 사용자 지정 헤더를 붙이려면 CORS 사전 요청을 보내고, 이 서버는 허용하지 않는다).
"""

from __future__ import annotations

import logging
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

from fastapi import Body, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from . import APP_ID, __version__
from .audio.base import AudioBackend, Voice
from .media import MediaError, MediaLibrary
from .models import Config, DayOff, Override, Program, Settings, Slot, Step
from .runner import Job, Runner, RunnerBusy
from .schedule import NEXT_SEARCH_DAYS, next_occurrence
from .storage import ConfigError, ConfigStore
from .timetable import build_week, describe_next, home_week_start, week_start
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
            "ducks": config.settings.pause_media or config.settings.mute_others,
            "has_programs": bool(config.programs),
            "can_update": s.shell.exe_path() is not None,
        }

    @app.get("/api/week")
    def week(start: date | None = None):
        if start is not None and not date(2000, 1, 1) <= start <= date(9000, 1, 1):
            raise _bad(422, "볼 수 없는 날짜입니다.")
        now = s.now()
        runner = s.runner.status()
        live = None
        if runner.get("kind") == "scheduled" and runner.get("slot_id") and runner.get("date"):
            live = (date.fromisoformat(runner["date"]), runner["slot_id"])
        config = cfg()
        return build_week(config, start or home_week_start(config, now.date()), now, live)

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
            raise _bad(409, f"예약된 방송({', '.join(users)})이 이 구성을 써서 지울 수 없습니다. 시간표에서 그 방송을 먼저 지우세요.")
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
    def delete_slot(slot_id: str, with_program: bool = False):
        """with_program이면 이 방송만 쓰던 방송 구성도 함께 지운다(새 방송 만들기는 둘을 같이 만든다)."""

        def mutate(c: Config):
            slot = c.slots.pop(_index(c.slots, slot_id, "회차"))
            c.overrides = [o for o in c.overrides if o.slot_id != slot_id]
            still_used = any(sl.program_id == slot.program_id for sl in c.slots) or any(o.program_id == slot.program_id for o in c.overrides)
            if with_program and not still_used:
                c.programs = [p for p in c.programs if p.id != slot.program_id]

        update(mutate)
        return Response(status_code=204)

    def _draft_slot(body: dict, program_id: str) -> Slot:
        return Slot.model_validate({
            "name": str(body.get("name") or "").strip() or "새 방송",
            "time": body.get("time"),
            "weekdays": body.get("weekdays") or [],
            "dates": body.get("dates") or [],
            "program_id": program_id,
            "start_date": body.get("start_date"),
            "end_date": body.get("end_date"),
        })

    def _date_states(slot: Slot) -> list[dict]:
        from .schedule import date_state

        config, now = cfg(), s.now()
        return [{"date": d.isoformat(), "state": date_state(config, slot.time, d, now)} for d in sorted(slot.dates)]

    @app.post("/api/broadcasts/check")
    def check_broadcast(body: dict = Body(...)):
        """만들기 전에 고른 날짜마다 실제로 나가는지 알려 준다(지난 시각·쉬는 날)."""
        slot = _draft_slot(body, "draft")
        return {"dates": _date_states(slot)}

    @app.post("/api/broadcasts", status_code=201)
    def create_broadcast(body: dict = Body(...)):
        """새 방송 만들기: 방송 구성과 회차를 한 번에 만든다. 둘 중 하나라도 잘못되면 아무것도 만들지 않는다."""
        name = str(body.get("name") or "").strip()
        program = Program.model_validate({"name": name, "steps": body.get("steps") or []})
        _check_files_exist(program)
        slot = _draft_slot(body, program.id)
        if slot.dates and not any(d["state"] == "ok" for d in _date_states(slot)):
            raise _bad(422, "고른 날짜에는 나갈 방송이 없습니다. 지났거나 쉬는 날입니다.")

        def mutate(c: Config):
            c.programs.append(program)
            c.slots.append(slot)

        update(mutate)
        nxt = next((o for o in _upcoming_for(slot.id)), None)
        return {"program": program.model_dump(mode="json"), "slot": slot.model_dump(mode="json"), "next": nxt}

    def _upcoming_for(slot_id: str):
        from datetime import timedelta

        from .schedule import resolve_day

        now = s.now()
        for offset in range(NEXT_SEARCH_DAYS):
            day = now.date() + timedelta(days=offset)
            for occ in resolve_day(cfg(), day):
                if occ.slot_id == slot_id and not occ.skipped and occ.at > now:
                    yield {"date": occ.date.isoformat(), "time": occ.time.strftime("%H:%M")}

    # 쉬는 날·예외 -------------------------------------------------------------
    @app.post("/api/days-off", status_code=201)
    def add_day_off(body: dict = Body(...)):
        body.pop("id", None)
        day_off = DayOff.model_validate(body)

        result: dict = {}

        def mutate(c: Config):
            if any(d.start <= day_off.start and day_off.end <= d.end for d in c.days_off):
                raise _bad(409, "이미 쉬는 날입니다.")
            # 겹치거나 맞닿은 기간은 하나로 합친다(목록에 같은 날이 두 번 나오지 않게)
            one_day = timedelta(days=1)
            touching = [d for d in c.days_off if d.start <= day_off.end + one_day and day_off.start <= d.end + one_day]
            merged = day_off
            if touching:
                merged = DayOff(
                    start=min([day_off.start, *(d.start for d in touching)]),
                    end=max([day_off.end, *(d.end for d in touching)]),
                    memo=day_off.memo or next((d.memo for d in touching if d.memo), ""),
                )
                c.days_off = [d for d in c.days_off if d not in touching]
            c.days_off.append(merged)
            result.update(merged.model_dump(mode="json"))

        update(mutate)
        return result

    @app.delete("/api/days-off/{day_off_id}", status_code=204)
    def delete_day_off(day_off_id: str):
        update(lambda c: c.days_off.pop(_index(c.days_off, day_off_id, "쉬는 날")))
        return Response(status_code=204)

    @app.get("/api/days-off")
    def list_days_off():
        return [d.model_dump(mode="json") for d in sorted(cfg().days_off, key=lambda d: d.start)]

    def _check_change_not_past(override: Override) -> None:
        """이미 나갔거나 놓친 회차를 다른 시각으로 옮기면 한 번 더 방송된다. 지난 시각으로 옮겨도 나가지 않는다."""
        from .models import parse_hhmm
        from .schedule import resolve_day

        now = s.now()
        current = next((o for o in resolve_day(cfg(), override.date) if o.slot_id == override.slot_id), None)
        if current is not None and current.at <= now and not current.skipped:
            raise _bad(409, "이미 지난 방송은 바꿀 수 없습니다.")
        if override.time and datetime.combine(override.date, parse_hhmm(override.time)) <= now:
            raise _bad(422, "이미 지난 시각입니다. 지금 이후 시각을 고르세요.")

    @app.put("/api/overrides")
    def put_override(body: dict = Body(...)):
        body.pop("id", None)
        override = Override.model_validate(body)
        if override.action == "change":
            _check_change_not_past(override)

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
        try:
            s.runner.enqueue(Job(kind="manual", name=program.name, program=program))
        except RunnerBusy as exc:
            raise _bad(409, str(exc)) from exc
        return {"ok": True}

    @app.post("/api/broadcast/stop")
    def broadcast_stop(body: dict | None = Body(default=None)):
        kind = (body or {}).get("kind")
        if kind not in (None, "preview", "scheduled", "manual"):
            raise _bad(422, "알 수 없는 종류입니다.")
        return {"stopped": s.runner.stop_current(kind=kind)}

    @app.post("/api/broadcast/skip")
    def broadcast_skip():
        return {"skipped": s.runner.skip_current()}

    @app.post("/api/preview", status_code=202)
    def preview(body: dict = Body(...)):
        """단계 하나({kind, ...}) 또는 방송 구성 전체({name, steps})를 다른 소리 처리 없이 들려준다."""
        if "steps" in body:
            program = Program.model_validate({"name": str(body.get("name") or "").strip() or "미리듣기", "steps": body["steps"]})
        else:
            program = Program(name="미리듣기", steps=[Step.model_validate({**body, "repeat": 1, "gap_sec": 0})])
        _check_files_exist(program)
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

    # 설정 ------------------------------------------------------------------
    @app.get("/api/settings")
    def get_settings():
        return cfg().settings.model_dump(mode="json")

    @app.patch("/api/settings")
    def patch_settings(body: dict = Body(...)):
        """바꾼 항목만 합친다. 동시에 온 요청이 서로의 변경을 지우지 않도록 저장 잠금 안에서 합친다."""
        Settings.model_validate({**cfg().settings.model_dump(), **body})  # 먼저 형식 검사(잘못되면 422)
        result: dict = {}

        def mutate(c: Config):
            before = c.settings
            merged = Settings.model_validate({**before.model_dump(), **body})
            if merged.autostart != before.autostart:
                try:
                    s.shell.set_autostart(merged.autostart)
                except OSError as exc:
                    raise _bad(500, f"자동 실행 설정을 바꾸지 못했습니다: {exc}") from exc
            c.settings = merged
            result.update(merged.model_dump(mode="json"))

        update(mutate)
        return result

    @app.post("/api/settings/reset")
    def reset_settings():
        # 자동 방송 켜기/끄기는 화면 위쪽 스위치로 따로 다루므로 그대로 둔다
        defaults = Settings(auto_broadcast=cfg().settings.auto_broadcast)
        return patch_settings(defaults.model_dump(mode="json"))

    @app.get("/api/export")
    def export_config():
        return Response(
            content=cfg().model_dump_json(indent=2),
            media_type="application/json",
            headers={"Content-Disposition": 'attachment; filename="jeongsi-config.json"'},
        )

    @app.post("/api/import")
    def import_config(body: Any = Body(...)):
        from .storage import migrate

        try:
            body = migrate(body)
        except (ConfigError, ValueError) as exc:
            raise _bad(422, str(exc)) from exc
        config = Config.model_validate(body)
        if config.settings.autostart != cfg().settings.autostart:
            try:
                s.shell.set_autostart(config.settings.autostart)
            except OSError as exc:
                raise _bad(500, f"자동 실행 설정을 바꾸지 못했습니다: {exc}") from exc
        s.store.replace(config)
        # 소리 파일은 내보내기에 들어 있지 않다: 이 PC에 없는 파일을 알려 media 폴더를 옮기게 한다
        have = {m["name"] for m in s.media.list()}
        missing = sorted({st.file for p in config.programs for st in p.steps if st.kind == "audio" and st.file not in have})
        return {"ok": True, "missing_files": missing}

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
        if status_.get("state") in ("downloading", "ready"):
            raise _bad(409, "이미 업데이트를 진행하고 있습니다.")
        if s.runner.on_air:
            raise _bad(409, "방송 중에는 업데이트할 수 없습니다. 방송이 끝난 뒤 다시 시도하세요.")
        exe = s.shell.exe_path()
        if exe is None:
            raise _bad(409, "개발 모드에서는 업데이트를 적용할 수 없습니다.")
        from .updater import ReleaseInfo

        release = ReleaseInfo(**status_["release"])

        s.updater.mark_downloading()  # 스레드 시작 전에 바꿔야 두 번 눌러도 한 번만 진행된다

        def work():
            try:
                # exe와 같은 폴더에 받아야 같은 드라이브 안에서 바로 바꿀 수 있고, 쓰기 권한도 미리 확인된다
                new_file = s.updater.download(release, exe.parent)
                # 받는 사이 방송이 시작됐으면 끝날 때까지 기다린 뒤 바꾼다(방송을 끊지 않음)
                waited = 0
                while s.runner.busy and waited < 3600:
                    time.sleep(1)
                    waited += 1
                # 포트·데이터 폴더 같은 실행 인자는 새 버전에도 그대로 넘긴다
                keep = [a for a in sys.argv[1:] if a not in ("--autostart", "--updated")]
                apply_update(new_file, exe, extra_args=keep)
                s.shell.request_exit()
            except UpdateError as exc:
                log.error("업데이트 실패: %s", exc)
                s.updater.mark_error(str(exc))
            except Exception:
                log.exception("업데이트 중 예상치 못한 오류")
                s.updater.mark_error("업데이트하지 못했습니다. 잠시 뒤 다시 시도하세요.")

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
