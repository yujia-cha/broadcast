// 새 방송 만들기: 질문 하나씩 답하면 다음 칸이 위에 나타나고, 답한 칸은 아래에 쌓인다(눌러서 고칠 수 있음).
// 마지막에 요약을 확인·동의하면 방송 구성과 회차를 한 번에 만든다.
import { api, get, post } from "../api.js";
import { WEEKDAYS, confirmDialog, fmtDate, h, icon, toast, toastError, weekdaySummary } from "../ui.js";

const REPEATS = [1, 2, 3, 4, 5];
const CONTENT = { tts: "음성 안내", audio: "음악·소리", both: "음성 안내 + 음악" };

let ctx, root, st;

function freshState() {
  return {
    draft: {
      name: "", content: null, text: "", ttsRepeat: null, file: null, audioRepeat: null,
      time: "", dayMode: null, weekdays: [], startMode: null, startDate: "", endMode: null, endDate: "", agreed: false,
    },
    current: "name",
    answered: new Set(),
    result: null,
    busy: false,
  };
}

const today = () => ctx.status.now.slice(0, 10);
const startOf = (d) => (d.startMode === "date" ? d.startDate : today());
const mediaName = (name) => ctx.media.find((m) => m.name === name)?.display ?? "";

const STEPS = [
  { id: "name", label: "이름", title: "방송 이름을 정해 주세요", valid: (d) => d.name.trim().length > 0, summary: (d) => d.name.trim(), render: nameField },
  { id: "content", label: "내용", title: "무엇을 내보낼까요?", valid: (d) => !!d.content, summary: (d) => CONTENT[d.content], render: contentField },
  { id: "text", label: "문구", show: (d) => d.content !== "audio", title: "읽어 줄 문구를 입력해 주세요", valid: (d) => d.text.trim().length > 0, summary: (d) => d.text.trim(), render: textField },
  { id: "ttsRepeat", label: "읽는 횟수", show: (d) => d.content !== "audio", title: "몇 번 읽을까요?", valid: (d) => !!d.ttsRepeat, summary: (d) => `${d.ttsRepeat}번`, render: (d) => repeatField(d, "ttsRepeat") },
  { id: "file", label: "파일", show: (d) => d.content !== "tts", title: "어떤 파일을 틀까요?", valid: (d) => !!mediaName(d.file), summary: (d) => mediaName(d.file), render: fileField },
  { id: "audioRepeat", label: "트는 횟수", show: (d) => d.content !== "tts", title: "몇 번 틀까요?", valid: (d) => !!d.audioRepeat, summary: (d) => `${d.audioRepeat}번`, render: (d) => repeatField(d, "audioRepeat") },
  { id: "time", label: "시각", title: "몇 시에 내보낼까요?", valid: (d) => /^\d\d:\d\d$/.test(d.time), summary: (d) => d.time, render: timeField },
  { id: "days", label: "요일", title: "무슨 요일에 내보낼까요?", valid: (d) => d.weekdays.length > 0, summary: (d) => weekdaySummary(d.weekdays), render: daysField },
  { id: "start", label: "시작", title: "언제부터 시작할까요?", valid: (d) => d.startMode === "today" || (d.startMode === "date" && d.startDate >= today()), summary: (d) => (d.startMode === "today" ? "오늘부터" : `${fmtDate(d.startDate)}부터`), render: startField },
  { id: "end", label: "끝", title: "언제까지 할까요?", valid: (d) => d.endMode === "none" || (d.endMode === "date" && !!d.endDate && d.endDate >= startOf(d)), summary: (d) => (d.endMode === "none" ? "계속" : `${fmtDate(d.endDate)}까지`), render: endField },
];

const visibleSteps = () => STEPS.filter((s) => !s.show || s.show(st.draft));
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
  const ok = await confirmDialog({ title: "새 방송 만들기를 그만할까요?", message: "입력한 내용이 사라집니다.", confirm: "그만하기", cancel: "계속 만들기", danger: true });
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
  const pending = after.find((s) => !st.answered.has(s.id) || !s.valid(st.draft))
    ?? steps.find((s) => !s.valid(st.draft));
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
  if (d.content !== "tts") steps.push({ kind: "audio", file: d.file, repeat: d.audioRepeat, label: mediaName(d.file).replace(/\.[^.]+$/, "").slice(0, 20) });
  return {
    name: d.name.trim(),
    steps,
    time: d.time,
    weekdays: d.weekdays,
    start_date: d.startMode === "date" ? d.startDate : null,
    end_date: d.endMode === "date" ? d.endDate : null,
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
  const title = confirming ? "이대로 만들까요?" : cur.title;

  const primary = confirming
    ? h("button", { class: "btn pri wz-cta", disabled: !st.draft.agreed || st.busy, on: { click: create } }, st.busy ? "만드는 중…" : "만들기")
    : h("button", { class: "btn pri wz-cta", id: "wz-next", disabled: !cur.valid(st.draft), on: { click: next } }, "다음");

  const answered = confirming ? [] : steps
    .filter((s) => s.id !== st.current && st.answered.has(s.id) && s.valid(st.draft))
    .reverse()
    .map((s) =>
      h("button", { class: "wz-answer", on: { click: () => goTo(s.id) }, "aria-label": `${s.label} 고치기: ${s.summary(st.draft)}` },
        h("span", { class: "wz-answer-label" }, s.label),
        h("span", { class: "wz-answer-value" }, s.summary(st.draft)),
      ));

  const page = h("div", { class: "wz" },
    h("div", { class: "wz-top" },
      h("button", { class: "ibtn", "aria-label": "이전", on: { click: back } }, icon("left")),
      h("div", { class: "wz-progress", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": steps.length, "aria-valuenow": index },
        h("i", { style: { width: `${Math.round((index / steps.length) * 100)}%` } })),
      h("button", { class: "ibtn", "aria-label": "닫기", on: { click: () => ctx.go("timetable") } }, icon("x")),
    ),
    h("h1", { class: "wz-q", id: "wz-q", "aria-live": "polite" }, title),
    h("div", { class: "wz-active" }, confirming ? confirmView() : cur.render(st.draft)),
    answered.length ? h("div", { class: "wz-answers" }, answered) : null,
    h("div", { class: "wz-bar" }, primary),
  );
  root.replaceChildren(page);
  if (focus) root.querySelector(".wz-active input:not([type=checkbox]), .wz-active textarea, .wz-active button")?.focus();
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

function choices(options, selected, pick) {
  return h("div", { class: "wz-choices", role: "radiogroup", "aria-labelledby": "wz-q" },
    options.map(([value, label]) =>
      h("button", { class: "wz-choice", role: "radio", "aria-checked": String(selected === value), on: { click: () => pick(value) } }, label)));
}

function contentField(d) {
  return choices(Object.entries(CONTENT), d.content, (value) => {
    d.content = value;
    next(); // 고르면 바로 다음으로
  });
}

function textField(d) {
  const area = h("textarea", {
    class: "input wz-input", rows: 3, maxlength: 2000, placeholder: "예: 점심시간입니다. 손을 씻고 급식실로 이동해 주세요.", "aria-labelledby": "wz-q",
    value: d.text,
    on: {
      input: (e) => { d.text = e.target.value; refreshPrimary(); },
      keydown: (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); next(); } },
    },
  });
  const listen = h("button", { class: "btn sm", on: { click: () => {
    if (!d.text.trim()) return;
    post("/api/preview", { kind: "tts", text: d.text.trim() }).catch(toastError);
  } } }, icon("play"), "들어 보기");
  return h("div", { class: "wz-stack" }, area, h("div", null, listen));
}

function repeatField(d, key) {
  return choices(REPEATS.map((n) => [n, `${n}번`]), d[key], (value) => {
    d[key] = value;
    next();
  });
}

function fileField(d) {
  const input = h("input", { type: "file", accept: ".mp3,.wav,.flac,.ogg,audio/*", hidden: true, on: { change: upload } });
  const uploadBtn = h("button", { class: "btn", on: { click: () => input.click() } }, icon("upload"), "파일 올리기");
  async function upload() {
    const file = input.files?.[0];
    if (!file) return;
    uploadBtn.disabled = true;
    uploadBtn.textContent = "올리는 중…";
    const form = new FormData();
    form.append("file", file);
    try {
      const media = await api("POST", "/api/media", form);
      await ctx.loadMedia();
      d.file = media.name;
      next();
    } catch (err) {
      toastError(err);
      render();
    }
  }
  const list = ctx.media.length
    ? choices(ctx.media.map((m) => [m.name, m.display]), d.file, (value) => { d.file = value; next(); })
    : null;
  return h("div", { class: "wz-stack" }, list, h("div", null, uploadBtn, input));
}

function timeField(d) {
  return h("input", {
    class: "input wz-input wz-time", type: "time", value: d.time, "aria-labelledby": "wz-q",
    on: { input: (e) => { d.time = e.target.value; refreshPrimary(); }, keydown: onEnter },
  });
}

function daysField(d) {
  const presets = { weekdays: [0, 1, 2, 3, 4], everyday: [0, 1, 2, 3, 4, 5, 6] };
  const toggles = h("div", { class: "toggles", role: "group", "aria-label": "요일 고르기", hidden: d.dayMode !== "custom" },
    WEEKDAYS.map((label, i) =>
      h("button", { "aria-pressed": String(d.weekdays.includes(i)), on: { click: (e) => {
        d.weekdays = d.weekdays.includes(i) ? d.weekdays.filter((x) => x !== i) : [...d.weekdays, i].sort();
        e.currentTarget.setAttribute("aria-pressed", String(d.weekdays.includes(i)));
        refreshPrimary();
      } } }, label)));
  return h("div", { class: "wz-stack" },
    choices([["weekdays", "평일 (월~금)"], ["everyday", "매일"], ["custom", "직접 고르기"]], d.dayMode, (value) => {
      d.dayMode = value;
      if (value === "custom") {
        if (!d.weekdays.length) d.weekdays = [];
        render();
        root.querySelector(".toggles button")?.focus();
        return;
      }
      d.weekdays = presets[value];
      next();
    }),
    toggles,
  );
}

function dateChoice(d, modeKey, dateKey, presetValue, presetLabel, min) {
  const dateInput = h("input", {
    class: "input wz-input", type: "date", min, value: d[dateKey], hidden: d[modeKey] !== "date", "aria-label": "날짜",
    on: { input: (e) => { d[dateKey] = e.target.value; refreshPrimary(); }, keydown: onEnter },
  });
  return h("div", { class: "wz-stack" },
    choices([[presetValue, presetLabel], ["date", "날짜 고르기"]], d[modeKey], (value) => {
      d[modeKey] = value;
      if (value === "date") {
        if (!d[dateKey]) d[dateKey] = min;
        render();
        root.querySelector(".wz-active input[type=date]")?.focus();
        return;
      }
      next();
    }),
    dateInput,
  );
}

function startField(d) {
  return dateChoice(d, "startMode", "startDate", "today", "오늘부터", today());
}

function endField(d) {
  return dateChoice(d, "endMode", "endDate", "none", "계속", startOf(d));
}

// 확인 ------------------------------------------------------------------------
function confirmView() {
  const d = st.draft;
  const rows = visibleSteps().map((s) =>
    h("button", { class: "wz-row", on: { click: () => goTo(s.id) }, "aria-label": `${s.label} 고치기` },
      h("span", { class: "wz-answer-label" }, s.label),
      h("span", { class: "wz-row-value" }, s.summary(d)),
      icon("right"),
    ));
  const ducks = ctx.status?.ducks !== false;
  const clash = clashingSlots(d);
  const check = h("label", { class: "wz-agree" },
    h("input", { type: "checkbox", id: "wz-agree", checked: d.agreed, on: { change: (e) => { d.agreed = e.target.checked; render(); } } }),
    h("span", null, `${weekdaySummary(d.weekdays)} ${d.time}에 ${ducks ? "다른 소리를 잠시 멈추고 " : ""}방송해요`),
  );
  return h("div", { class: "wz-stack" },
    h("div", { class: "wz-summary" }, rows),
    clash.length ? h("p", { class: "err", role: "status" }, `같은 시각에 '${clash.join("', '")}' 회차가 있어 이어서 방송돼요.`) : null,
    check,
  );
}

function clashingSlots(d) {
  return (ctx.weekSlots || []).filter((s) => s.enabled && s.time === d.time && s.weekdays.some((w) => d.weekdays.includes(w))).map((s) => s.name);
}

// 완료 ------------------------------------------------------------------------
function renderDone() {
  const r = st.result;
  const d = st.draft;
  const first = r.next ? `${fmtDate(r.next.date)} ${r.next.time}` : "예정된 날이 없습니다";
  root.replaceChildren(
    h("div", { class: "wz wz-done" },
      h("div", { class: "wz-check", "aria-hidden": "true" }, icon("check")),
      h("h1", { class: "wz-q", id: "wz-q" }, "예약했어요"),
      h("p", { class: "meta", style: { margin: 0 } }, `${d.name.trim()} · 첫 방송 ${first}`),
      h("div", { class: "wz-bar wz-bar-2" },
        h("button", { class: "btn wz-cta", on: { click: () => post("/api/preview", { name: d.name.trim(), steps: toBody(d).steps }).then(() => toast("미리듣기를 시작합니다.")).catch(toastError) } }, icon("play"), "한 번 들어 보기"),
        h("button", { class: "btn pri wz-cta", on: { click: () => { st = null; ctx.go("timetable"); } } }, "시간표 보기"),
      ),
    ),
  );
  root.querySelector(".wz-done .btn.pri")?.focus();
}
