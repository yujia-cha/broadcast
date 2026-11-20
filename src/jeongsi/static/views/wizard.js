// 새 방송 만들기: 질문 하나씩, 그림을 눌러 답한다. 답하면 다음 칸이 위에 나타나고 답한 칸은 아래에 쌓인다.
// 마지막에 티켓 모양 요약을 확인하면 방송 구성과 회차를 한 번에 만든다.
import { api, get, post } from "../api.js";
import { confirmDialog, fmtDate, fmtDuration, h, icon, toast, toastError, weekdaySummary } from "../ui.js";
import { countPicker, dateChips, dayDots, multiDateCalendar, strip, timePicker, weekdayPicker } from "../visual.js";

let ctx, root, st;

function freshState() {
  return {
    draft: { name: "", content: null, text: "", ttsRepeat: null, file: null, audioRepeat: null, time: "", mode: null, weekdays: [], dates: [], agreed: false },
    current: "name",
    answered: new Set(),
    result: null,
    busy: false,
  };
}

const today = () => ctx.status.now.slice(0, 10);
const media = (name) => ctx.media.find((m) => m.name === name);
const stripOf = (d) => [
  ...(d.content && d.content !== "audio" ? [{ kind: "tts", repeat: d.ttsRepeat || 1 }] : []),
  ...(d.content && d.content !== "tts" ? [{ kind: "audio", repeat: d.audioRepeat || 1 }] : []),
];
const whenPicture = (d) => (d.mode === "dates" ? dateChips(d.dates) : dayDots(d.weekdays));

const STEPS = [
  { id: "name", icon: "edit", title: "방송 이름", valid: (d) => d.name.trim().length > 0, show_: (d) => d.name.trim(), render: nameField },
  { id: "content", icon: "volume", title: "무엇을 내보낼까요?", valid: (d) => !!d.content, show_: (d) => strip(stripOf({ ...d, ttsRepeat: 1, audioRepeat: 1 }), { size: "sm" }), render: contentField },
  { id: "text", icon: "speech", when: (d) => d.content !== "audio", title: "읽어 줄 문구", valid: (d) => d.text.trim().length > 0, show_: (d) => d.text.trim(), render: textField },
  { id: "ttsRepeat", icon: "speech", when: (d) => d.content !== "audio", title: "몇 번 읽을까요?", valid: (d) => !!d.ttsRepeat, show_: (d) => strip([{ kind: "tts", repeat: d.ttsRepeat }], { size: "sm" }), render: (d) => countPicker("tts", d.ttsRepeat, (n) => { d.ttsRepeat = n; next(); }) },
  { id: "file", icon: "music", when: (d) => d.content !== "tts", title: "어떤 음악?", valid: (d) => !!media(d.file), show_: (d) => media(d.file)?.display, render: fileField },
  { id: "audioRepeat", icon: "music", when: (d) => d.content !== "tts", title: "몇 번 틀까요?", valid: (d) => !!d.audioRepeat, show_: (d) => strip([{ kind: "audio", repeat: d.audioRepeat }], { size: "sm" }), render: (d) => countPicker("audio", d.audioRepeat, (n) => { d.audioRepeat = n; next(); }) },
  { id: "time", icon: "clock", title: "몇 시에?", valid: (d) => /^\d\d:\d\d$/.test(d.time), show_: (d) => d.time, render: timeField },
  { id: "mode", icon: "calendarOff", title: "어떻게 반복할까요?", valid: (d) => !!d.mode, show_: (d) => (d.mode === "dates" ? "특정 날짜" : "매주"), render: modeField },
  { id: "days", icon: "calendarOff", when: (d) => d.mode !== "dates", title: "무슨 요일마다?", valid: (d) => d.weekdays.length > 0, show_: (d) => dayDots(d.weekdays), render: daysField },
  { id: "dates", icon: "calendarOff", when: (d) => d.mode === "dates", title: "어느 날짜에?", valid: (d) => d.dates.length > 0, show_: (d) => dateChips(d.dates), render: datesField },
];

const visibleSteps = () => STEPS.filter((s) => !s.when || s.when(st.draft));
const stepById = (id) => STEPS.find((s) => s.id === id);

export function mount(el, appCtx) {
  ctx = appCtx;
  root = el;
  if (!st || st.result) st = freshState();
  render(true);
  get("/api/week").then((w) => (ctx.weekSlots = w.rows.map((r) => r.slot))).catch(() => (ctx.weekSlots = []));
}

export function unmount() {
  root = null;
}

export async function canLeave() {
  const dirty = st && !st.result && (st.answered.size > 0 || st.draft.name.trim());
  if (!dirty) return true;
  const ok = await confirmDialog({ title: "만들기를 그만할까요?", confirm: "그만하기", cancel: "계속", danger: true });
  if (ok) st = null;
  return ok;
}

// 흐름 -------------------------------------------------------------------------
function next() {
  const steps = visibleSteps();
  const cur = stepById(st.current);
  if (cur && !cur.valid(st.draft)) return;
  if (cur) st.answered.add(cur.id);
  const after = steps.slice(steps.findIndex((s) => s.id === st.current) + 1);
  const pending = after.find((s) => !st.answered.has(s.id) || !s.valid(st.draft)) ?? steps.find((s) => !s.valid(st.draft));
  st.current = pending ? pending.id : "confirm";
  render(true);
}

function goTo(id) {
  st.current = id;
  render(true);
}

function back() {
  const steps = visibleSteps();
  if (st.current === "confirm") return goTo(steps.at(-1).id);
  const i = steps.findIndex((s) => s.id === st.current);
  if (i > 0) goTo(steps[i - 1].id);
  else ctx.go("timetable");
}

function toBody(d) {
  const steps = [];
  if (d.content !== "audio") steps.push({ kind: "tts", text: d.text.trim(), repeat: d.ttsRepeat, gap_sec: d.ttsRepeat > 1 ? 1 : 0 });
  if (d.content !== "tts") steps.push({ kind: "audio", file: d.file, repeat: d.audioRepeat, label: (media(d.file)?.display ?? "").replace(/\.[^.]+$/, "").slice(0, 20) });
  return {
    name: d.name.trim(), steps, time: d.time,
    weekdays: d.mode === "dates" ? [] : d.weekdays,
    dates: d.mode === "dates" ? d.dates : [],
  };
}

async function create() {
  if (st.busy || !st.draft.agreed) return;
  st.busy = true;
  render();
  try {
    st.result = await post("/api/broadcasts", toBody(st.draft));
    await ctx.loadPrograms();
    st.current = "done";
  } catch (err) {
    toastError(err);
  } finally {
    st.busy = false;
    render(true);
  }
}

// 그리기 -----------------------------------------------------------------------
function render(focus = false) {
  if (!root) return;
  if (st.current === "done") return renderDone();
  const steps = visibleSteps();
  const confirming = st.current === "confirm";
  const index = confirming ? steps.length : steps.findIndex((s) => s.id === st.current);
  const cur = stepById(st.current);
  const field = confirming ? ticket(st.draft, true) : cur.render(st.draft); // 칸이 기본값을 정할 수 있어 먼저 그린다

  const primary = confirming
    ? h("button", { class: "btn pri wz-cta", disabled: !st.draft.agreed || st.busy, on: { click: create } }, st.busy ? "만드는 중…" : "만들기")
    : h("button", { class: "btn pri wz-cta", id: "wz-next", disabled: !cur.valid(st.draft), on: { click: next } }, "다음");

  const answered = confirming ? [] : steps
    .filter((s) => s.id !== st.current && st.answered.has(s.id) && s.valid(st.draft))
    .reverse()
    .map((s) => answerChip(s, () => goTo(s.id)));

  root.replaceChildren(h("div", { class: "wz" },
    h("div", { class: "wz-top" },
      h("button", { class: "ibtn", "aria-label": "이전", on: { click: back } }, icon("left")),
      h("div", { class: "wz-progress", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": steps.length, "aria-valuenow": index },
        h("i", { style: { width: `${Math.round((index / steps.length) * 100)}%` } })),
      h("button", { class: "ibtn", "aria-label": "닫기", on: { click: () => ctx.go("timetable") } }, icon("x")),
    ),
    h("h1", { class: "wz-q", id: "wz-q", "aria-live": "polite" }, confirming ? "이대로 만들까요?" : cur.title),
    h("div", { class: "wz-active" }, field),
    answered.length ? h("div", { class: "wz-answers" }, answered) : null,
    h("div", { class: "wz-bar" }, primary),
  ));
  if (focus) focusField();
}

// Enter가 "다음"이 되도록 칸의 중심 조작부에 초점을 둔다(시각은 핀, 선택지는 고른 것)
function focusField() {
  const area = root.querySelector(".wz-active");
  if (!area) return;
  for (const sel of ["input:not([type=checkbox])", "textarea", ".tp-pin", "[aria-checked='true']", "[role=radio]", "button"]) {
    const el = area.querySelector(sel);
    if (el) return el.focus();
  }
}

function answerChip(step, onClick) {
  return h("button", { class: "wz-answer", on: { click: onClick }, "aria-label": `${step.title} 고치기` },
    h("span", { class: "wz-answer-i" }, icon(step.icon)),
    h("span", { class: "wz-answer-value" }, step.show_(st.draft)),
    icon("edit"));
}

function refreshPrimary() {
  const btn = root?.querySelector("#wz-next");
  const cur = stepById(st.current);
  if (btn && cur) btn.disabled = !cur.valid(st.draft);
}

// 칸 --------------------------------------------------------------------------
function onEnter(e) {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    next();
  }
}

function nameField(d) {
  return h("input", {
    class: "input wz-input", value: d.name, maxlength: 40, placeholder: "예: 점심 안내", "aria-labelledby": "wz-q",
    on: { input: (e) => { d.name = e.target.value; refreshPrimary(); }, keydown: onEnter },
  });
}

function contentField(d) {
  const options = [["tts", [{ kind: "tts" }], "음성"], ["audio", [{ kind: "audio" }], "음악"], ["both", [{ kind: "tts" }, { kind: "audio" }], "음성 + 음악"]];
  return h("div", { class: "wz-tiles", role: "radiogroup", "aria-labelledby": "wz-q" },
    options.map(([value, items, label]) =>
      h("button", { class: "wz-tile", role: "radio", "aria-checked": String(d.content === value), on: { click: () => { d.content = value; next(); } } },
        strip(items, { size: "lg" }), h("span", null, label))));
}

function textField(d) {
  const area = h("textarea", {
    class: "input wz-input", rows: 3, maxlength: 2000, placeholder: "예: 점심시간입니다.", "aria-labelledby": "wz-q", value: d.text,
    on: {
      input: (e) => { d.text = e.target.value; refreshPrimary(); },
      keydown: (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); next(); } },
    },
  });
  const listen = h("button", { class: "round-play", "aria-label": "들어 보기", on: { click: () => {
    if (d.text.trim()) post("/api/preview", { kind: "tts", text: d.text.trim() }).catch(toastError);
  } } }, icon("play"));
  return h("div", { class: "wz-speak" }, area, listen);
}

function fileField(d) {
  const input = h("input", { type: "file", accept: ".mp3,.wav,.flac,.ogg,audio/*", hidden: true, on: { change: upload } });
  const uploadTile = h("button", { class: "wz-file wz-upload", on: { click: () => input.click() } }, h("span", { class: "wz-file-i" }, icon("upload")), h("span", null, "파일 올리기"));
  async function upload() {
    const file = input.files?.[0];
    if (!file) return;
    uploadTile.disabled = true;
    uploadTile.lastChild.textContent = "올리는 중…";
    const form = new FormData();
    form.append("file", file);
    try {
      const m = await api("POST", "/api/media", form);
      await ctx.loadMedia();
      d.file = m.name;
      next();
    } catch (err) {
      toastError(err);
      render();
    }
  }
  const longest = Math.max(1, ...ctx.media.map((m) => m.seconds || 0));
  return h("div", { class: "wz-files", role: "radiogroup", "aria-labelledby": "wz-q" },
    ctx.media.map((m) =>
      h("button", { class: "wz-file", role: "radio", "aria-checked": String(d.file === m.name), on: { click: () => { d.file = m.name; next(); } } },
        h("span", { class: "wz-file-i blk-audio" }, icon("music")),
        h("span", { class: "wz-file-n" }, m.display),
        h("span", { class: "wz-file-len" }, h("i", { style: { width: `${Math.max(6, ((m.seconds || 0) / longest) * 100)}%` } })),
        h("small", null, m.seconds ? fmtDuration(m.seconds) : ""))),
    uploadTile, input);
}

function timeField(d) {
  if (!d.time) d.time = "12:00";
  return timePicker(d.time, (v, done) => { d.time = v; refreshPrimary(); if (done) next(); });
}

function daysField(d) {
  return weekdayPicker(d.weekdays, (days, preset) => { d.weekdays = days; refreshPrimary(); if (preset) next(); });
}

function modeField(d) {
  const art = (kind) => h("span", { class: `when-art${kind === "dates" ? " cal" : ""}`, "aria-hidden": "true" },
    Array.from({ length: 14 }, (_, i) => h("i", { class: (kind === "weekly" ? i % 7 < 5 : [2, 9, 11].includes(i)) ? "on" : "" })));
  return h("div", { class: "wz-tiles two", role: "radiogroup", "aria-labelledby": "wz-q" },
    [["weekly", "매주"], ["dates", "특정 날짜"]].map(([value, label]) =>
      h("button", { class: "wz-tile", role: "radio", "aria-checked": String(d.mode === value), on: { click: () => { d.mode = value; next(); } } },
        art(value), h("span", null, label))));
}

function datesField(d) {
  return multiDateCalendar({ dates: d.dates, min: today() }, (dates) => { d.dates = dates; refreshPrimary(); });
}

// 티켓 요약 ---------------------------------------------------------------------
function ticket(d, editable) {
  const row = (id, content) => editable
    ? h("button", { class: "tk-row", "aria-label": `${stepById(id).title} 고치기`, on: { click: () => goTo(id) } }, content)
    : h("div", { class: "tk-row" }, content);
  const clash = (ctx.weekSlots || []).filter((s) => s.enabled && s.time === d.time && sameDay(s, d)).map((s) => s.name);
  return h("div", { class: "wz-stack" },
    h("div", { class: "ticket" },
      h("div", { class: "tk-top" }, row("time", h("span", { class: "tk-time" }, d.time)), row(d.mode === "dates" ? "dates" : "days", whenPicture(d))),
      row("name", h("span", { class: "tk-name" }, d.name.trim())),
      row("content", strip(stripOf(d), { size: "lg" })),
      d.content !== "audio" ? row("text", h("span", { class: "tk-text" }, icon("speech"), d.text.trim())) : null,
      d.content !== "tts" ? row("file", h("span", { class: "tk-text" }, icon("music"), media(d.file)?.display ?? "")) : null,
    ),
    clash.length ? h("p", { class: "err", role: "status" }, `같은 시각: ${clash.join(", ")}`) : null,
    editable ? h("label", { class: "wz-agree" },
      h("input", { type: "checkbox", id: "wz-agree", checked: d.agreed, on: { change: (e) => { d.agreed = e.target.checked; render(); } } }),
      h("span", null, `${d.mode === "dates" ? "고른 날" : weekdaySummary(d.weekdays)} ${d.time}에 ${ctx.status?.ducks !== false ? "다른 소리를 잠시 멈추고 " : ""}방송해요`)) : null,
  );
}

// 완료 ------------------------------------------------------------------------
function renderDone() {
  const r = st.result;
  const d = st.draft;
  root.replaceChildren(
    h("div", { class: "wz wz-done" },
      h("div", { class: "wz-check", "aria-hidden": "true" }, icon("check")),
      h("h1", { class: "wz-q", id: "wz-q" }, "예약했어요"),
      ticket(d, false),
      r.next ? h("p", { class: "meta", style: { margin: 0 } }, `첫 방송 ${fmtDate(r.next.date)} ${r.next.time}`) : null,
      h("div", { class: "wz-bar wz-bar-2" },
        h("button", { class: "btn wz-cta", on: { click: () => post("/api/preview", { name: d.name.trim(), steps: toBody(d).steps }).then(() => toast("미리듣기를 시작합니다.")).catch(toastError) } }, icon("play"), "들어 보기"),
        h("button", { class: "btn pri wz-cta", on: { click: () => { st = null; ctx.go("timetable"); } } }, "시간표 보기"),
      ),
    ),
  );
  root.querySelector(".wz-done .btn.pri")?.focus();
}

// 같은 날 방송하는지(요일 또는 날짜가 겹치는지)
function sameDay(slot, d) {
  const wd = (iso) => (new Date(`${iso}T00:00:00`).getDay() + 6) % 7;
  if (d.mode === "dates") {
    return slot.dates?.length ? slot.dates.some((x) => d.dates.includes(x)) : d.dates.some((x) => slot.weekdays.includes(wd(x)));
  }
  return slot.dates?.length ? slot.dates.some((x) => d.weekdays.includes(wd(x))) : slot.weekdays.some((w) => d.weekdays.includes(w));
}
