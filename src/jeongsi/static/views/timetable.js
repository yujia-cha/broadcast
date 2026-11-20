// 시간표: 요일 열에 시각 위치로 방송 블록을 놓는다.
// 블록을 위아래로 끌면 그 날만 시각이 바뀌고, 누르면 아이콘 버튼이 나온다. 요일 머리를 누르면 그 날을 쉰다.
import { del, get, post, put } from "../api.js";
import {
  addDays, confirmDialog, fmtClock, fmtDate, fmtDuration, fmtIn, fmtMonthDay, fmtWeekTitle, h, icon, openDialog, toast, toastError,
} from "../ui.js";
import {
  closePopover, dayRuler, iconAction, multiDateCalendar, popover, rangeCalendar, strip, timePicker, toHHMM, toMinutes, weekdayPicker,
} from "../visual.js";

const SNAP = 5;
const MIN_HOUR_PX = 44; // 이보다 좁으면 블록 이름이 사라지므로 대신 스크롤한다
const DRAG_START_PX = 10; // 누르다 손이 조금 흔들려도 시각이 바뀌지 않게
const MAX_HOUR_PX = 64;
const BLOCK_PX = 46;
const blockPx = () => Math.max(26, Math.min(BLOCK_PX, st.hourPx - 4)); // 간격이 좁으면 블록도 낮춘다

let ctx, root, mainEl, nowEl;
const st = { start: null, week: null, lastSkip: null, weekKey: "", loadToken: 0, dragging: false, hourPx: 56 };
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (root && st.week && !st.dragging) renderGrid(); }, 150);
});

export function mount(el, appCtx) {
  ctx = appCtx;
  root = el;
  mainEl = h("section", { class: "cal-wrap", "aria-label": "주간 시간표" }, h("div", { class: "skel" }));
  nowEl = h("div");
  el.replaceChildren(h("div", { class: "tt-page" }, mainEl, h("aside", { class: "rail", "aria-label": "지금" }, nowEl)));
  st.weekKey = weekKey(ctx.status);
  st.scrolled = false;
  loadWeek();
  renderNow();
}

export function unmount() {
  closePopover();
  root = null;
}

export function onStatus(status) {
  if (!root) return;
  renderNow();
  const key = weekKey(status);
  if (key !== st.weekKey && !st.dragging) {
    st.weekKey = key;
    loadWeek();
  }
}

function weekKey(status) {
  if (!status) return "";
  const r = status.runner;
  const n = status.next;
  return [r.state === "idle" ? "idle" : "busy", r.slot_id, r.date, n?.date, n?.slot_id, n?.time, status.now.slice(0, 16), status.auto_broadcast].join("|");
}

async function loadWeek() {
  const token = ++st.loadToken;
  try {
    const week = await get(`/api/week${st.start ? `?start=${st.start}` : ""}`);
    if (token !== st.loadToken || !root || st.dragging) return;
    st.week = week;
    st.start = week.start;
    ctx.weekSlots = week.rows.map((r) => r.slot);
    renderGrid();
    renderNow();
  } catch (err) {
    if (!root) return;
    mainEl.replaceChildren(h("div", { class: "card empty" }, h("h3", null, "시간표를 불러오지 못했습니다"), h("p", null, err.message),
      h("button", { class: "btn", on: { click: loadWeek } }, "다시 시도")));
  }
}

async function refresh(message) {
  closePopover();
  if (message) toast(message);
  await loadWeek();
}

const nowMinutes = () => toMinutes(ctx.status.now.slice(11, 16));
const todayIso = () => ctx.status.now.slice(0, 10);

// 달력 -------------------------------------------------------------------------
function hourRange(rows) {
  const mins = [nowMinutes(), ...rows.flatMap((r) => r.cells.filter((c) => c.time).map((c) => toMinutes(c.time)))];
  let from = Math.min(8 * 60, ...mins.map((m) => Math.floor(m / 60) * 60 - 60));
  let to = Math.max(17 * 60, ...mins.map((m) => Math.ceil(m / 60) * 60 + 60));
  from = Math.max(0, from);
  to = Math.min(24 * 60, to);
  return { from, to };
}

function renderGrid() {
  const w = st.week;
  const isThisWeek = w.days.some((d) => d.date === todayIso());
  const bar = h("div", { class: "weekbar" },
    h("button", { class: "ibtn", "aria-label": "지난주", on: { click: () => changeWeek(-7) } }, icon("left")),
    h("button", { class: "ibtn", "aria-label": "다음 주", on: { click: () => changeWeek(7) } }, icon("right")),
    h("h2", null, fmtWeekTitle(w.days[0].date, w.days.at(-1).date)),
    isThisWeek ? null : h("button", { class: "btn sm", on: { click: () => { st.start = null; loadWeek(); } } }, "이번 주"),
    h("span", { class: "grow" }),
    h("button", { class: "btn sm ghost", on: { click: () => openDaysOffDialog() } }, icon("calendarOff"), "쉬는 날"),
  );

  if (!w.rows.length) {
    mainEl.replaceChildren(bar,
      h("button", { class: "cal-empty", on: { click: () => ctx.go("new") } },
        h("span", { class: "cal-empty-art", "aria-hidden": "true" },
          ...[0, 1, 2, 3, 4].map((i) => h("i", null, i === 2 ? h("b", null, icon("plus")) : null))),
        h("span", { class: "cal-empty-l" }, icon("plus"), "새 방송 만들기"),
      ));
    return;
  }

  const { from, to } = hourRange(w.rows);
  // 화면 높이에 맞춰 시간 간격을 정해 하루가 한 화면에 들어오게 한다
  const avail = Math.max(320, window.innerHeight - (mainEl.getBoundingClientRect().top || 56) - 150);
  st.hourPx = Math.max(MIN_HOUR_PX, Math.min(MAX_HOUR_PX, Math.floor(avail / ((to - from) / 60))));
  const HOUR_PX = st.hourPx;
  const height = ((to - from) / 60) * HOUR_PX + BLOCK_PX / 2; // 마지막 블록이 잘리지 않게
  const cols = `52px repeat(${w.days.length}, minmax(0, 1fr))`;
  const head = h("div", { class: "cal-head", style: { gridTemplateColumns: cols } }, h("span"),
    w.days.map((day) =>
      h("button", {
        class: `cal-day${day.is_today ? " today" : ""}${day.day_off ? " off" : ""}`,
        "aria-label": `${fmtDate(day.date)}${day.day_off ? ", 쉬는 날" : ""}`,
        on: { click: (e) => dayPopover(e.currentTarget, day) },
      },
        h("b", null, day.label),
        h("span", null, fmtMonthDay(day.date)),
        day.day_off ? h("i", { class: "cal-day-off" }, icon("ban")) : null,
      )));

  const axis = h("div", { class: "cal-axis", style: { height: `${height}px` } },
    Array.from({ length: (to - from) / 60 + 1 }, (_, i) =>
      h("span", { style: { top: `${i * HOUR_PX}px` } }, `${String(from / 60 + i).padStart(2, "0")}:00`)));

  const columns = w.days.map((day, di) => {
    const col = h("div", { class: `cal-col${day.is_today ? " today" : ""}${day.day_off ? " off" : ""}`, style: { height: `${height}px` } });
    for (let i = 0; i <= (to - from) / 60; i++) col.append(h("i", { class: "cal-line", style: { top: `${i * HOUR_PX}px` } }));
    const groups = new Map();
    for (const row of w.rows) {
      const cell = row.cells[di];
      if (cell.status === "none") continue;
      groups.set(cell.time, [...(groups.get(cell.time) || []), { row, cell }]);
    }
    for (const items of groups.values()) {
      items.forEach((item, i) => col.append(block(item.row, item.cell, from, i, items.length)));
    }
    if (day.is_today && nowMinutes() >= from && nowMinutes() <= to) {
      col.append(h("i", { class: "cal-now", style: { top: `${((nowMinutes() - from) / 60) * HOUR_PX}px` } }));
    }
    return col;
  });

  const body = h("div", { class: "cal-body", style: { gridTemplateColumns: cols } }, axis, columns);
  mainEl.replaceChildren(bar, h("div", { class: "cal" }, head, body));
  if (!st.scrolled) {
    // 처음 열 때 다음 방송(없으면 지금 선)이 보이게 한다
    st.scrolled = true;
    (mainEl.querySelector(".cblock.next, .cblock.live") || mainEl.querySelector(".cal-now"))?.scrollIntoView({ block: "nearest" });
  }
}

function block(row, cell, from, index, count) {
  const bh = blockPx();
  const top = ((toMinutes(cell.time) - from) / 60) * st.hourPx - bh / 2;
  const el = h("button", {
    class: `cblock ${cell.status}${cell.changed && cell.status !== "off" ? " chg" : ""}${bh < 40 ? " compact" : ""}`,
    style: { top: `${top}px`, height: `${bh}px`, left: `calc(${(index * 100) / count}% + 3px)`, width: `calc(${100 / count}% - 6px)` },
    "aria-label": `${fmtDate(cell.date)} ${cell.time} ${row.slot.name}`,
  },
    h("span", { class: "cb-top" },
      h("b", { class: "cb-time" }, cell.time),
      cell.status === "off" ? icon("ban") : cell.status === "live" ? h("span", { class: "dot" }) : null,
    ),
    h("span", { class: "cb-name" }, row.slot.name),
    strip(cell.strip || [], { size: "xs" }),
  );
  if (["scheduled", "next"].includes(cell.status)) enableDrag(el, row, cell, from);
  else el.addEventListener("click", () => blockPopover(el, row, cell));
  return el;
}

// 끌어서 그 날 시각 바꾸기 ---------------------------------------------------------------
function enableDrag(el, row, cell) {
  const startMin = toMinutes(cell.time);
  let startY = 0, moved = false, current = startMin, label;
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    startY = e.clientY;
    moved = false;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    const dy = e.clientY - startY;
    if (!moved && Math.abs(dy) < DRAG_START_PX) return;
    if (!moved) {
      moved = true;
      st.dragging = true;
      closePopover();
      el.classList.add("dragging");
      label = h("span", { class: "cb-drag-time" });
      el.append(label);
    }
    current = Math.round((startMin + (dy / st.hourPx) * 60) / SNAP) * SNAP;
    current = Math.max(0, Math.min(23 * 60 + 55, current));
    el.style.transform = `translateY(${((current - startMin) / 60) * st.hourPx}px)`;
    label.textContent = toHHMM(current);
  });
  el.addEventListener("pointerup", async (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    el.releasePointerCapture(e.pointerId);
    if (!moved) return blockPopover(el, row, cell);
    st.dragging = false;
    if (current === startMin) return renderGrid();
    await moveTime(row, cell, toHHMM(current), true);
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); blockPopover(el, row, cell); }
  });
}

async function moveTime(row, cell, hhmm, undoable = false) {
  try {
    if (hhmm === cell.original_time && cell.program_id === row.slot.program_id) {
      if (cell.override) await del(`/api/overrides/${cell.date}/${row.slot.id}`);
    } else {
      await put("/api/overrides", { date: cell.date, slot_id: row.slot.id, action: "change", time: hhmm, program_id: cell.program_id });
    }
    closePopover();
    await loadWeek();
    const undo = { label: "되돌리기", fn: () => moveTime(row, { ...cell, override: cell.override ?? { action: "change" } }, cell.time) };
    toast(`${fmtDate(cell.date)} ${row.slot.name} ${cell.time} → ${hhmm}`, undoable ? { action: undo } : {});
  } catch (err) {
    toastError(err);
    renderGrid();
  }
}

// 블록 팝오버 -------------------------------------------------------------------
function blockPopover(anchor, row, cell) {
  const past = ["past", "live"].includes(cell.status);
  const offByOverride = cell.status === "off" && cell.override?.action === "skip";
  const offByDay = cell.status === "off" && !cell.override;
  const program = ctx.programs.find((p) => p.id === cell.program_id);
  const actions = [];
  if (program) actions.push(iconAction("play", "지금", () => broadcastNow(program.id)));
  if (!past) {
    if (offByOverride) actions.push(iconAction("undo", "되살리기", () => clearOverride(row, cell, "다시 방송합니다.")));
    else if (offByDay) actions.push(iconAction("check", "이번만 켜기", () => setOverride(row, cell, { action: "change", time: cell.time }, `${fmtDate(cell.date)} ${cell.time} ${row.slot.name}만 방송합니다.`)));
    else actions.push(iconAction("ban", "이번만 끄기", () => setOverride(row, cell, { action: "skip" }, `${fmtDate(cell.date)} ${cell.time} ${row.slot.name} 끔`)));
    if (!offByOverride) actions.push(iconAction("clock", "시각", () => timeEditor(anchor, row, cell)));
    if (cell.changed) actions.push(iconAction("undo", "원래대로", () => clearOverride(row, cell, "원래대로 돌렸습니다.")));
  }
  actions.push(iconAction("edit", "편집", () => { closePopover(); openSlotDialog(row.slot); }));
  popover(anchor,
    h("div", { class: "pop-in" },
      h("div", { class: "pop-head" }, h("b", null, cell.time), h("span", null, row.slot.name), h("small", null, fmtDate(cell.date))),
      strip(cell.strip || [], { size: "sm" }),
      h("div", { class: "ia-row" }, actions),
    ));
}

function timeEditor(anchor, row, cell) {
  let value = cell.time;
  popover(anchor,
    h("div", { class: "pop-in" },
      h("div", { class: "pop-head" }, h("span", null, row.slot.name), h("small", null, fmtDate(cell.date))),
      timePicker(value, (v) => (value = v)),
      h("div", { class: "ia-row" }, h("button", { class: "btn pri", on: { click: () => moveTime(row, cell, value) } }, icon("check"), "적용")),
    ));
}

async function setOverride(row, cell, change, message) {
  try {
    await put("/api/overrides", { date: cell.date, slot_id: row.slot.id, ...change });
    await refresh(message);
  } catch (err) {
    toastError(err);
  }
}

async function clearOverride(row, cell, message) {
  try {
    await del(`/api/overrides/${cell.date}/${row.slot.id}`);
    await refresh(message);
  } catch (err) {
    toastError(err);
  }
}

// 요일 머리 팝오버: 이 날 쉬기 -------------------------------------------------------------
function dayPopover(anchor, day) {
  const off = day.day_off;
  const actions = off
    ? [iconAction("undo", off.start !== off.end ? "기간 해제" : "쉬기 해제", async () => {
        if (off.start !== off.end && !(await confirmDialog({ title: "쉬는 기간 해제", message: `${fmtDate(off.start)} ~ ${fmtDate(off.end)}`, confirm: "해제" }))) return;
        try { await del(`/api/days-off/${off.id}`); await refresh("쉬는 날을 해제했습니다."); } catch (err) { toastError(err); }
      })]
    : [iconAction("ban", "이 날 쉬기", async () => {
        try { await post("/api/days-off", { start: day.date, end: day.date, memo: "" }); await refresh(`${fmtDate(day.date)} 쉽니다.`); } catch (err) { toastError(err); }
      })];
  actions.push(iconAction("calendarOff", "여러 날", () => { closePopover(); openDaysOffDialog(day.date); }));
  popover(anchor, h("div", { class: "pop-in" },
    h("div", { class: "pop-head" }, h("b", null, fmtDate(day.date)), off?.memo ? h("small", null, off.memo) : null),
    h("div", { class: "ia-row" }, actions)));
}

function changeWeek(days) {
  st.start = addDays(st.week.start, days);
  loadWeek();
}

// 지금 패널 ---------------------------------------------------------------------
function renderNow() {
  const status = ctx.status;
  if (!status || !nowEl) return;
  const focusKey = nowEl.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
  const r = status.runner;
  if (r.state !== "idle" && r.kind !== "preview") nowEl.replaceChildren(liveCard(r));
  else if (r.state !== "idle") nowEl.replaceChildren(h("section", { class: "card" }, h("div", { class: "ck" }, h("span", { class: "liv" }, icon("volume"), "미리듣기")),
    h("div", { class: "ia-row" }, tag(iconAction("stop", "정지", () => post("/api/broadcast/stop", { kind: "preview" }).catch(toastError)), "stop-preview"))));
  else nowEl.replaceChildren(nextCard(status));
  if (focusKey) nowEl.querySelector(`[data-focus="${focusKey}"]`)?.focus();
}

function tag(el, key) {
  el.dataset.focus = key;
  return el;
}

function liveCard(r) {
  const plays = r.plays || [];
  const before = plays.slice(0, r.index).reduce((a, p) => a + p.seconds, 0);
  const cur = plays[r.index];
  const curElapsed = Math.min(r.play_elapsed || 0, cur?.seconds || 0);
  const total = plays.reduce((a, p) => a + p.seconds, 0);
  const index = r.state === "playing" ? r.index : r.state === "restoring" ? plays.length : -1;
  return h("section", { class: "card liveC", "aria-live": "polite" },
    h("div", { class: "ck" }, h("span", { class: "liv" }, h("span", { class: "dot" }), "방송 중"), h("span", null, `${fmtClock(before + curElapsed)} / ${fmtClock(total)}`)),
    h("span", { class: "nm" }, r.name),
    strip(plays, { size: "lg", index, ratio: cur?.seconds ? curElapsed / cur.seconds : 0, expanded: false }),
    h("div", { class: "ia-row" },
      tag(iconAction("skip", "넘기기", skipStep, { disabled: r.state !== "playing" }), "skip"),
      tag(iconAction("stop", "정지", stopBroadcast, { tone: "stop", disabled: r.state === "restoring" }), "stop"),
    ),
  );
}

function nextCard(status) {
  const n = status.next;
  const skip = st.lastSkip && Date.now() - st.lastSkip.at < 60000 ? st.lastSkip : null;
  const times = todayCells().map((c) => c.time);
  const ruler = times.length
    ? h("div", { class: "ruler-box" }, h("small", { class: "ruler-cap" }, `오늘 방송 ${times.length}회`), dayRuler(times, nowMinutes(), n?.date === todayIso() ? n.time : null))
    : null;
  if (!n) {
    return h("section", { class: "card" }, ruler,
      h("div", { class: "next-empty" }, icon(status.auto_broadcast ? "moon" : "ban"), h("span", null, status.auto_broadcast ? "예정 없음" : "자동 방송 꺼짐")),
      skip ? undoChip(skip) : null);
  }
  const when = n.date === todayIso() ? fmtIn(n.in_seconds) : fmtDate(n.date);
  return h("section", { class: "card" },
    h("div", { class: "ck" }, h("span", null, "다음"), h("span", null, when)),
    h("span", { class: "bigt" }, n.time),
    h("span", { class: "nm" }, n.name),
    strip(n.units, { size: "lg", expanded: false }),
    h("span", { class: "meta" }, `약 ${fmtDuration(n.seconds)}`),
    ruler,
    h("div", { class: "ia-row" },
      tag(iconAction("play", "지금", () => broadcastNow(n.program_id)), "now"),
      tag(iconAction("ban", "이번 끄기", skipNext), "skip-next"),
    ),
    skip ? undoChip(skip) : null,
  );
}

function undoChip(skip) {
  return h("button", { class: "undo-chip", "data-focus": "undo", on: { click: undoSkip } }, icon("undo"), `${skip.time} ${skip.name} 되돌리기`);
}

function todayCells() {
  if (!st.week) return [];
  const i = st.week.days.findIndex((d) => d.date === todayIso());
  if (i < 0) return [];
  return st.week.rows.map((r) => r.cells[i]).filter((c) => c.time && c.status !== "off");
}

async function broadcastNow(programId) {
  closePopover();
  try {
    await post("/api/broadcast", { program_id: programId });
    toast("방송을 시작합니다.");
  } catch (err) {
    toastError(err);
  }
}

async function stopBroadcast() {
  try {
    await post("/api/broadcast/stop");
    toast("방송을 멈췄습니다.");
  } catch (err) {
    toastError(err);
  }
}

async function skipStep() {
  try {
    await post("/api/broadcast/skip");
  } catch (err) {
    toastError(err);
  }
}

async function skipNext() {
  try {
    const res = await post("/api/skip-next");
    st.lastSkip = { ...res, at: Date.now() };
    await refresh(`${res.time} ${res.name} 끔`);
  } catch (err) {
    toastError(err);
  }
}

async function undoSkip() {
  const s = st.lastSkip;
  if (!s) return;
  try {
    if (s.previous) {
      const { id, ...prev } = s.previous;
      await put("/api/overrides", prev);
    } else {
      await del(`/api/overrides/${s.date}/${s.slot_id}`);
    }
    st.lastSkip = null;
    await refresh("되돌렸습니다.");
  } catch (err) {
    toastError(err);
  }
}

// 매주 일정 편집 ----------------------------------------------------------------------
export function openSlotDialog(slot) {
  const draft = { ...slot, weekdays: [...slot.weekdays], dates: [...(slot.dates || [])] };
  let mode = draft.dates.length ? "dates" : "weekly";
  let nameEl, progEl, errEl, enabledEl, confirmBox, whenBox, modeBox;
  let periodOpen = false;
  let overlapConfirmed = null;
  const paintWhen = () => {
    modeBox.replaceChildren(...[["weekly", "매주"], ["dates", "특정 날짜"]].map(([v, label]) =>
      h("button", { type: "button", class: "chip-btn", "aria-pressed": String(mode === v), on: { click: () => { mode = v; paintWhen(); } } }, label)));
    whenBox.replaceChildren(mode === "weekly"
      ? h("div", { class: "wz-stack" },
          weekdayPicker(draft.weekdays, (v) => (draft.weekdays = v)),
          periodField())
      : multiDateCalendar({ dates: draft.dates, min: addDays(todayIso(), -365) }, (v) => (draft.dates = v)));
  };
  // 기간: 평소에는 한 줄 요약, 누르면 달력(끝 없음 ∞). 달력을 고르는 동안에는 요약만 바꾼다
  function periodField() {
    const today = todayIso();
    const text = h("span");
    const paintSummary = () => {
      text.textContent = draft.start_date || draft.end_date
        ? `${draft.start_date ? fmtMonthDay(draft.start_date) : "지금"}부터 ${draft.end_date ? `${fmtMonthDay(draft.end_date)}까지` : "계속"}`
        : "지금부터 계속";
    };
    paintSummary();
    return h("div", { class: "period" },
      h("button", { type: "button", class: "chip-btn", "aria-expanded": String(periodOpen), on: { click: () => { periodOpen = !periodOpen; paintWhen(); } } },
        icon("calendar"), text, icon(periodOpen ? "up" : "down")),
      draft.start_date || draft.end_date ? h("button", { type: "button", class: "link", on: { click: () => { draft.start_date = null; draft.end_date = null; paintWhen(); } } }, "기간 없애기") : null,
      periodOpen ? rangeCalendar({
        start: draft.start_date || today, end: draft.end_date,
        min: draft.start_date && draft.start_date < today ? draft.start_date : today, allowOpen: true,
      }, (v) => { draft.start_date = v.start; draft.end_date = v.end; paintSummary(); }) : null,
    );
  }

  const { close } = openDialog("방송 편집", (close) =>
    h("form", { class: "dlg", on: { submit: (e) => { e.preventDefault(); save(); } } },
      (nameEl = h("input", { class: "input pg-name", value: draft.name, maxlength: 40, "aria-label": "이름", required: true })),
      timePicker(draft.time, (v) => (draft.time = v)),
      (modeBox = h("div", { class: "mode-seg", role: "group", "aria-label": "반복" })),
      (whenBox = h("div")),
      h("label", { class: "field" }, h("span", null, "방송 구성"),
        (progEl = h("select", { class: "input" }, ctx.programs.map((p) => h("option", { value: p.id, selected: p.id === draft.program_id }, p.name))))),
      h("label", { style: { display: "flex", gap: "var(--s2)", alignItems: "center" } },
        (enabledEl = h("input", { type: "checkbox", checked: draft.enabled, style: { width: "18px", height: "18px", accentColor: "var(--accent)" } })), "사용"),
      (errEl = h("p", { class: "err", role: "alert" })),
      (confirmBox = h("div", { hidden: true })),
      h("div", { class: "dlg-foot" },
        h("button", { type: "button", class: "btn danger", on: { click: askDelete } }, icon("trash"), "삭제"),
        h("span", { class: "grow" }),
        h("button", { type: "button", class: "btn", on: { click: () => close() } }, "취소"),
        h("button", { type: "submit", class: "btn pri" }, "저장"),
      ),
    ));
  paintWhen();

  async function save() {
    errEl.textContent = "";
    const weekly = mode === "weekly";
    const body = {
      name: nameEl.value.trim(), time: draft.time, program_id: progEl.value, enabled: enabledEl.checked,
      weekdays: weekly ? draft.weekdays : [], dates: weekly ? [] : draft.dates,
      start_date: weekly ? draft.start_date || null : null, end_date: weekly ? draft.end_date || null : null,
    };
    if (!body.name) return (errEl.textContent = "이름을 입력하세요.");
    if (weekly && !body.weekdays.length) return (errEl.textContent = "요일을 하나 이상 고르세요.");
    if (!weekly && !body.dates.length) return (errEl.textContent = "날짜를 하나 이상 고르세요.");
    if (body.start_date && body.end_date && body.end_date < body.start_date) return (errEl.textContent = "종료일이 시작일보다 빠릅니다.");
    const clash = (ctx.weekSlots || []).filter((s) => s.id !== slot.id && s.enabled && body.enabled && s.time === body.time
      && (weekly && !s.dates?.length ? s.weekdays.some((d) => body.weekdays.includes(d)) : (s.dates || []).some((d) => body.dates.includes(d))));
    const key = `${body.time}|${body.weekdays.join(",")}|${body.dates.join(",")}`;
    if (clash.length && overlapConfirmed !== key) {
      overlapConfirmed = key;
      errEl.textContent = `같은 시각(${body.time})에 '${clash.map((s) => s.name).join("', '")}'이(가) 있어 이어서 방송돼요. 한 번 더 누르면 저장합니다.`;
      return;
    }
    try {
      await put(`/api/slots/${slot.id}`, body);
      close();
      await refresh("저장했습니다.");
    } catch (err) {
      errEl.textContent = err.message;
    }
  }

  function askDelete() {
    confirmBox.hidden = false;
    confirmBox.replaceChildren(h("div", { class: "confirm-row" },
      h("span", { class: "grow" }, "이 방송을 지웁니다."),
      h("button", { type: "button", class: "btn sm", on: { click: () => (confirmBox.hidden = true) } }, "취소"),
      h("button", { type: "button", class: "btn sm stop", on: { click: async () => {
        try { await del(`/api/slots/${slot.id}`); close(); await refresh("지웠습니다."); } catch (err) { errEl.textContent = err.message; }
      } } }, "지우기")));
  }
}

// 쉬는 날: 달력에서 기간 고르기. 이미 쉬는 날은 빗금, 처음엔 아무 날도 고르지 않는다 -----------------------
async function openDaysOffDialog(prefill) {
  let list, memoEl, errEl, calBox, addBtn;
  let items = [];
  let range = prefill ? { start: prefill, end: prefill } : { start: null, end: null };
  let view = prefill; // 추가한 뒤에도 보던 달을 그대로 보여 준다
  const marked = () => {
    const map = new Map();
    for (const d of items) for (let x = d.start; x <= d.end; x = addDays(x, 1)) map.set(x, d.memo || "쉬는 날");
    return map;
  };
  const paintCalendar = () => {
    calBox.replaceChildren(rangeCalendar({ start: range.start, end: range.end, min: todayIso(), allowOpen: false, marked: marked(), view },
      (v) => { range = { start: v.start, end: v.end || v.start }; view = v.start; addBtn.disabled = !range.start; }));
    addBtn.disabled = !range.start;
  };
  const paint = async () => {
    try {
      items = await get("/api/days-off");
      list.replaceChildren(...items.map((d) =>
        h("span", { class: "off-chip" }, icon("ban"),
          `${fmtMonthDay(d.start)}${d.start === d.end ? "" : `~${fmtMonthDay(d.end)}`}${d.memo ? ` ${d.memo}` : ""}`,
          h("button", { class: "off-x", "aria-label": "삭제", on: { click: async () => {
            try { await del(`/api/days-off/${d.id}`); await paint(); await loadWeek(); } catch (err) { errEl.textContent = err.message; }
          } } }, icon("x")))));
      paintCalendar();
    } catch (err) {
      errEl.textContent = err.message;
    }
  };
  openDialog("쉬는 날", (close) =>
    h("div", { class: "dlg" },
      h("h2", null, "쉬는 날"),
      (list = h("div", { class: "off-list" })),
      (calBox = h("div")),
      (memoEl = h("input", { class: "input", maxlength: 60, placeholder: "메모 (예: 겨울 방학)", "aria-label": "메모" })),
      (errEl = h("p", { class: "err", role: "alert" })),
      h("div", { class: "dlg-foot" },
        h("button", { class: "btn", on: { click: () => close() } }, "닫기"),
        (addBtn = h("button", { class: "btn pri", disabled: true, on: { click: async () => {
          errEl.textContent = "";
          try {
            await post("/api/days-off", { start: range.start, end: range.end, memo: memoEl.value.trim() });
            memoEl.value = "";
            range = { start: null, end: null };
            await paint();
            await loadWeek();
            toast("쉬는 날을 추가했습니다.");
          } catch (err) {
            errEl.textContent = err.message;
          }
        } } }, icon("plus"), "추가")),
      ),
    ));
  await paint();
}
