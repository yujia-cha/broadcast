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
const MIN_HOUR_PX = 50; // 이보다 좁으면 블록 이름이 사라지므로 대신 스크롤한다
const DRAG_START_PX = 10; // 누르다 손이 조금 흔들려도 시각이 바뀌지 않게
const MAX_HOUR_PX = 64;
const BLOCK_PX = 46;
const blockPx = () => Math.max(26, Math.min(BLOCK_PX, st.hourPx - 4)); // 간격이 좁으면 블록도 낮춘다

let ctx, root, mainEl, nowEl;
const st = { start: null, followHome: true, week: null, lastSkip: null, weekKey: "", loadToken: 0, dragging: false, hourPx: 56, openCell: null };
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
  el.replaceChildren(h("div", { class: "tt-page" }, h("aside", { class: "rail", "aria-label": "지금" }, nowEl), mainEl));
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
    // 다른 주로 넘기지 않았으면 늘 '처음 보여 줄 주'를 따른다(자정이 지나 주가 바뀌어도 따라감)
    const week = await get(`/api/week${!st.followHome && st.start ? `?start=${st.start}` : ""}`);
    if (token !== st.loadToken || !root || st.dragging) return;
    st.week = week;
    st.start = week.start;
    // 지금 패널의 '오늘' 눈금은 다른 주를 보고 있어도 이번 주 기준으로 그린다
    const thisWeek = week.days.some((d) => d.date === todayIso()) ? week : await get("/api/week").catch(() => null);
    if (token !== st.loadToken || !root) return;
    st.today = thisWeek ? todayOf(thisWeek) : st.today;
    ctx.weekSlots = week.rows.map((r) => r.slot);
    renderGrid();
    renderNow();
    closeStalePopover();
  } catch (err) {
    if (!root) return;
    mainEl.replaceChildren(h("div", { class: "card empty" }, h("h3", null, "시간표를 불러오지 못했습니다"), h("p", null, err.message),
      h("button", { class: "btn", on: { click: loadWeek } }, "다시 시도")));
  }
}

// 열어 둔 블록 팝오버가 가리키는 회차의 상태가 바뀌었으면(예: 그 사이 방송이 나감) 닫는다
function closeStalePopover() {
  const o = st.openCell;
  if (!o || !document.querySelector(".pop")) return;
  const row = st.week?.rows.find((r) => r.slot.id === o.slotId);
  const cell = row?.cells.find((c) => c.date === o.date);
  if (!cell || cell.status !== o.status || cell.time !== o.time) {
    closePopover();
    st.openCell = null;
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
  const mins = rows.flatMap((r) => r.cells.filter((c) => c.time).map((c) => toMinutes(c.time)));
  let from = Math.min(8 * 60, ...mins.map((m) => Math.floor(m / 60) * 60 - 60));
  let to = Math.max(17 * 60, ...mins.map((m) => Math.ceil(m / 60) * 60 + 60));
  from = Math.max(0, from);
  to = Math.min(24 * 60, to);
  return { from, to };
}

function renderGrid() {
  const w = st.week;
  const isThisWeek = w.start === w.home;
  const bar = h("div", { class: "weekbar" },
    h("button", { class: "ibtn", "aria-label": "지난주", on: { click: () => changeWeek(-7) } }, icon("left")),
    h("button", { class: "ibtn", "aria-label": "다음 주", on: { click: () => changeWeek(7) } }, icon("right")),
    h("h2", null, fmtWeekTitle(w.days[0].date, w.days.at(-1).date)),
    isThisWeek ? null : h("button", { class: "btn sm", on: { click: () => { st.start = null; st.followHome = true; loadWeek(); } } }, "이번 주"),
    h("span", { class: "grow" }),
    w.rows.length ? legend() : null,
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
        day.day_off ? h("i", { class: "cal-day-off" }, icon("calendarOff")) : null,
        day.day_off?.memo ? h("small", { class: "cal-day-memo" }, day.day_off.memo) : null,
      )));

  const axis = h("div", { class: "cal-axis", style: { height: `${height}px` } },
    Array.from({ length: (to - from) / 60 + 1 }, (_, i) =>
      h("span", { style: { top: `${i * HOUR_PX}px` } }, `${String(from / 60 + i).padStart(2, "0")}:00`)));

  const columns = w.days.map((day, di) => {
    const col = h("div", { class: `cal-col${day.is_today ? " today" : ""}${day.day_off ? " off" : ""}`, style: { height: `${height}px` } });
    for (let i = 0; i <= (to - from) / 60; i++) col.append(h("i", { class: "cal-line", style: { top: `${i * HOUR_PX}px` } }));
    const items = w.rows.map((row) => ({ row, cell: row.cells[di] })).filter((x) => x.cell.status !== "none");
    for (const { item, lane, lanes } of layoutLanes(items)) col.append(block(item.row, item.cell, from, lane, lanes));
    if (day.is_today && nowMinutes() >= from && nowMinutes() <= to) {
      col.append(h("i", { class: "cal-now", style: { top: `${((nowMinutes() - from) / 60) * HOUR_PX}px` } }));
    }
    return col;
  });

  const body = h("div", { class: "cal-body", style: { gridTemplateColumns: cols } }, axis, columns);
  mainEl.replaceChildren(bar, h("div", { class: "cal" }, head, body));
  if (!st.scrolled) {
    // 처음 열 때 다음 방송(없으면 지금 선)이 보이게 한다. 좁은 창에선 위의 지금 패널이 가려지므로 하지 않는다
    st.scrolled = true;
    if (window.innerWidth > 1100)
    (mainEl.querySelector(".cblock.next, .cblock.live") || mainEl.querySelector(".cal-now"))?.scrollIntoView({ block: "nearest" });
  }
}

// 세로로 겹치는 블록(시각 차이가 블록 높이보다 작음)은 한 무리로 묶어 나란히 놓는다
function layoutLanes(items) {
  const minGap = (blockPx() / st.hourPx) * 60; // 블록 높이를 분으로
  const sorted = [...items].sort((a, b) => toMinutes(a.cell.time) - toMinutes(b.cell.time));
  const out = [];
  let cluster = [], clusterEnd = -Infinity;
  const flush = () => {
    const laneEnds = [];
    const placed = cluster.map((item) => {
      const start = toMinutes(item.cell.time);
      let lane = laneEnds.findIndex((end) => end <= start);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = start + minGap;
      return { item, lane };
    });
    placed.forEach((p) => out.push({ ...p, lanes: laneEnds.length }));
    cluster = [];
  };
  for (const item of sorted) {
    const start = toMinutes(item.cell.time);
    if (cluster.length && start >= clusterEnd) flush();
    cluster.push(item);
    clusterEnd = cluster.length === 1 ? start + minGap : Math.max(clusterEnd, start + minGap);
  }
  if (cluster.length) flush();
  return out;
}

function statusWord(cell) {
  if (cell.status === "off") return cell.override?.action === "skip" ? "이번만 끔" : "쉬는 날";
  if (cell.status === "disabled") return "꺼 둔 방송";
  if (cell.changed) return "이 날만 바뀜";
  return { next: "다음 방송", past: "지남", live: "방송 중", scheduled: "예정" }[cell.status] || "";
}

function legend() {
  const item = (cls, label) => h("span", { class: "lg-item" }, h("i", { class: `lg-sw ${cls}` }), label);
  return h("span", { class: "legend", "aria-hidden": "true" },
    item("next", "다음"), item("chg", "이 날만 바뀜"), item("off", "끔·쉬는 날"), item("disabled", "꺼 둠"));
}

function block(row, cell, from, index, count) {
  const bh = blockPx();
  const top = ((toMinutes(cell.time) - from) / 60) * st.hourPx - bh / 2;
  const el = h("button", {
    class: `cblock ${cell.status}${cell.changed && cell.status !== "off" ? " chg" : ""}${bh < 44 ? " compact" : ""}`,
    style: { top: `${top}px`, height: `${bh}px`, left: `calc(${(index * 100) / count}% + 3px)`, width: `calc(${100 / count}% - 6px)` },
    "aria-label": `${fmtDate(cell.date)} ${cell.time} ${row.slot.name}, ${statusWord(cell)}`,
  },
    h("span", { class: "cb-top" },
      h("b", { class: "cb-time" }, cell.time),
      cell.status === "off" ? icon(cell.override?.action === "skip" ? "ban" : "calendarOff")
        : cell.status === "disabled" ? icon("ban")
        : cell.status === "live" ? h("span", { class: "dot" }) : null,
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
    if (undoable === "undo") return toast("되돌렸습니다.");
    const undo = { label: "되돌리기", fn: () => moveTime(row, { ...cell, time: hhmm, override: { action: "change" } }, cell.time, "undo") };
    toast(`${fmtDate(cell.date)} ${row.slot.name} ${cell.time} → ${hhmm}`, undoable ? { action: undo } : {});
  } catch (err) {
    toastError(err);
    renderGrid();
  }
}

// 블록 팝오버 -------------------------------------------------------------------
function blockPopover(anchor, row, cell) {
  if (cell.status === "disabled") {
    return popover(anchor, h("div", { class: "pop-in" },
      h("div", { class: "pop-head" }, h("b", null, cell.time), h("span", null, row.slot.name), h("small", null, "꺼 둔 방송")),
      h("div", { class: "ia-row" },
        iconAction("check", "다시 켜기", () => setEnabled(row.slot, true)),
        iconAction("edit", "방송 편집", () => { closePopover(); openSlotDialog(row.slot); }),
      )));
  }
  st.openCell = { slotId: row.slot.id, date: cell.date, status: cell.status, time: cell.time };
  const past = ["past", "live"].includes(cell.status);
  const offByOverride = cell.status === "off" && cell.override?.action === "skip";
  const offByDay = cell.status === "off" && !cell.override;
  const program = ctx.programs.find((p) => p.id === cell.program_id);
  const actions = [];
  if (program) actions.push(iconAction("play", "지금", () => broadcastNow(program.id, row.slot.name)));
  if (!past) {
    if (offByOverride) actions.push(iconAction("undo", "되살리기", () => revive(row, cell)));
    else if (offByDay) actions.push(iconAction("check", "이번만 켜기", () => setOverride(row, cell, { action: "change", time: cell.time }, `${fmtDate(cell.date)} ${cell.time} ${row.slot.name}만 방송합니다.`)));
    else {
      // 끄기 전에 바꿔 둔 시각·구성(또는 쉬는 날 '이번만 켜기')을 함께 남겨 '되살리기'로 그대로 돌아오게 한다
      const keep = cell.override?.action === "change" ? { time: cell.time, program_id: cell.program_id } : {};
      actions.push(iconAction("ban", "이번만 끄기", () => setOverride(row, cell, { action: "skip", ...keep }, `${fmtDate(cell.date)} ${cell.time} ${row.slot.name} 끔`, true)));
    }
    if (!offByOverride && !offByDay) actions.push(iconAction("clock", "이 날만 시각", () => timeEditor(anchor, row, cell)));
    if (cell.changed) actions.push(iconAction("undo", "원래대로", () => clearOverride(row, cell, "원래대로 돌렸습니다.")));
  }
  actions.push(iconAction("edit", "방송 편집", () => { closePopover(); openSlotDialog(row.slot); }));
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
      timePicker(value, (v, done) => { value = v; if (done) moveTime(row, cell, value, true); }),
      h("div", { class: "ia-row" }, h("button", { class: "btn pri", on: { click: () => moveTime(row, cell, value, true) } }, icon("check"), "적용")),
    ));
}

async function setOverride(row, cell, change, message, undoable = false) {
  try {
    await put("/api/overrides", { date: cell.date, slot_id: row.slot.id, ...change });
    closePopover();
    await loadWeek();
    const before = cell.override;
    const undo = async () => {
      try {
        if (before) { const { id, ...prev } = before; await put("/api/overrides", prev); }
        else await del(`/api/overrides/${cell.date}/${row.slot.id}`);
        await refresh("되돌렸습니다.");
      } catch (err) { toastError(err); }
    };
    toast(message, undoable ? { action: { label: "되돌리기", fn: undo } } : {});
  } catch (err) {
    toastError(err);
  }
}

async function setEnabled(slot, enabled) {
  try {
    await put(`/api/slots/${slot.id}`, { ...slot, enabled });
    closePopover();
    await loadWeek();
    toast(enabled ? `${slot.name}을(를) 다시 켰습니다.` : `${slot.name}을(를) 껐습니다.`,
      { action: { label: "되돌리기", fn: () => setEnabled({ ...slot, enabled }, !enabled) } });
  } catch (err) {
    toastError(err);
  }
}

// 되살리기: 끄기 전 상태로. 바꿔 둔 시각이 있으면 그 시각으로, 쉬는 날이면 '이번만 켜기'로 돌아간다
async function revive(row, cell) {
  const ov = cell.override || {};
  const dayOff = st.week?.days.find((d) => d.date === cell.date)?.day_off;
  try {
    if (ov.time || ov.program_id || dayOff) {
      await put("/api/overrides", { date: cell.date, slot_id: row.slot.id, action: "change", time: ov.time || cell.original_time, program_id: ov.program_id || null });
    } else {
      await del(`/api/overrides/${cell.date}/${row.slot.id}`);
    }
    await refresh(`${fmtDate(cell.date)} ${ov.time || cell.original_time} ${row.slot.name} 다시 방송합니다.`);
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
        try {
          const made = await post("/api/days-off", { start: day.date, end: day.date, memo: "" });
          closePopover();
          await loadWeek();
          const undo = async () => {
            try {
              // 합쳐진 기간이면 하루만 빼기 어렵다: 이 날 하나로 새로 만든 경우에만 지운다
              if (made.start === day.date && made.end === day.date) await del(`/api/days-off/${made.id}`);
              await refresh("되돌렸습니다.");
            } catch (err) { toastError(err); }
          };
          toast(`${fmtDate(day.date)} 쉽니다.`, made.start === made.end ? { action: { label: "되돌리기", fn: undo } } : {});
        } catch (err) { toastError(err); }
      })];
  actions.push(iconAction("calendarOff", "여러 날", () => { closePopover(); openDaysOffDialog(day.date); }));
  popover(anchor, h("div", { class: "pop-in" },
    h("div", { class: "pop-head" }, h("b", null, fmtDate(day.date)), off?.memo ? h("small", null, off.memo) : null),
    h("div", { class: "ia-row" }, actions)));
}

function changeWeek(days) {
  st.start = addDays(st.week.start, days);
  st.followHome = st.start === st.week.home;
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
      tag(iconAction("play", "지금", () => broadcastNow(n.program_id, n.name)), "now"),
      tag(iconAction("ban", "이번만 끄기", skipNext), "skip-next"),
    ),
    skip ? undoChip(skip) : null,
  );
}

function undoChip(skip) {
  return h("button", { class: "undo-chip", "data-focus": "undo", on: { click: undoSkip } }, icon("undo"), `${skip.time} ${skip.name} 되돌리기`);
}

function todayOf(week) {
  const i = week.days.findIndex((d) => d.date === todayIso());
  if (i < 0) return [];
  return week.rows.map((r) => r.cells[i]).filter((c) => c.time && c.status !== "off");
}

const todayCells = () => st.today || [];

async function broadcastNow(programId, name) {
  closePopover();
  // 스피커로 바로 나가는 일이므로 한 번 묻는다(예약된 방송은 그대로 나간다)
  if (!(await confirmDialog({ title: `'${name}'을(를) 지금 방송할까요?`, message: "다른 소리를 잠시 멈추고 바로 내보냅니다.", confirm: "지금 방송" }))) return;
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
  let nameEl, progEl, errEl, enabledEl, confirmBox, whenBox, modeBox, stripBox;
  const paintStrip = () => {
    const program = ctx.programs.find((p) => p.id === progEl.value);
    stripBox.replaceChildren(strip(program?.steps || [], { size: "sm" }));
  };
  let periodOpen = false;
  let overlapConfirmed = null;
  const paintWhen = () => {
    modeBox.replaceChildren(...[["weekly", "매주"], ["dates", "특정 날짜"]].map(([v, label]) =>
      h("button", { type: "button", class: "chip-btn", "aria-pressed": String(mode === v), on: { click: () => { mode = v; paintWhen(); } } }, label)));
    whenBox.replaceChildren(mode === "weekly"
      ? h("div", { class: "wz-stack" },
          weekdayPicker(draft.weekdays, (v) => (draft.weekdays = v)),
          periodField())
      : datesWithStates());
  };
  function datesWithStates() {
    let seq = 0;
    const cal = multiDateCalendar({ dates: draft.dates, min: todayIso() }, (v) => { draft.dates = v; check(); });
    const check = async () => {
      const mine = ++seq;
      if (!draft.dates.length) return cal.setStates({});
      try {
        const res = await post("/api/broadcasts/check", { time: draft.time, dates: draft.dates });
        if (mine === seq) cal.setStates(Object.fromEntries(res.dates.map((x) => [x.date, x.state])));
      } catch { /* 저장할 때 다시 확인한다 */ }
    };
    check();
    return cal;
  }

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
      periodOpen ? rangeCalendar({
        start: draft.start_date || today, end: draft.end_date,
        min: draft.start_date && draft.start_date < today ? draft.start_date : today, allowOpen: true,
      }, (v) => { draft.start_date = v.start; draft.end_date = v.end; paintSummary(); }) : null,
      h("button", { type: "button", class: "link", on: { click: () => { draft.start_date = null; draft.end_date = null; paintWhen(); } } }, "기간 없애기"),
    );
  }

  const { close } = openDialog("방송 편집", (close) =>
    h("form", { class: "dlg", on: { submit: (e) => { e.preventDefault(); save(); } } },
      h("div", { class: "dlg-head" },
        h("h2", null, "방송 편집"),
        h("label", { class: "toggle-row" }, h("span", null, "켜짐"),
          (enabledEl = h("input", { type: "checkbox", role: "switch", class: "toggle", checked: draft.enabled, "aria-label": "이 방송 켜짐" }))),
      ),
      h("label", { class: "field" }, h("span", null, "이름"),
        (nameEl = h("input", { class: "input pg-name", value: draft.name, maxlength: 40, required: true }))),
      h("div", { class: "field" }, h("span", null, "시각"), timePicker(draft.time, (v) => (draft.time = v))),
      h("div", { class: "field" }, h("span", { id: "dlg-repeat" }, "반복"),
        (modeBox = h("div", { class: "mode-seg", role: "group", "aria-labelledby": "dlg-repeat" })),
        (whenBox = h("div"))),
      h("div", { class: "field" }, h("span", null, "내용"),
        h("div", { class: "content-row" },
          (stripBox = h("span")),
          (progEl = h("select", { class: "input", "aria-label": "방송 내용", on: { change: paintStrip } },
            ctx.programs.map((p) => h("option", { value: p.id, selected: p.id === draft.program_id }, p.name)))),
          h("button", { type: "button", class: "btn sm", on: { click: () => { close(); ctx.selectProgramId = progEl.value; ctx.go("programs"); } } }, icon("edit"), "내용 바꾸기"),
        )),
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
  paintStrip();

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
    if (!weekly && body.enabled) {
      // 고른 날이 모두 지났거나 쉬는 날이면 저장해도 나가지 않는다
      try {
        const res = await post("/api/broadcasts/check", { time: body.time, dates: body.dates });
        if (!res.dates.some((x) => x.state === "ok")) return (errEl.textContent = "고른 날에는 방송이 나가지 않아요(지났거나 쉬는 날). 다른 날을 고르세요.");
      } catch { /* 확인하지 못하면 그대로 저장 */ }
    }
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
      h("span", { class: "grow" }, "이 방송을 지웁니다. 다른 방송이 쓰지 않는 내용도 함께 지워집니다."),
      h("button", { type: "button", class: "btn sm", on: { click: () => (confirmBox.hidden = true) } }, "취소"),
      h("button", { type: "button", class: "btn sm stop", on: { click: async () => {
        try { await del(`/api/slots/${slot.id}?with_program=true`); close(); await ctx.loadPrograms(); await refresh("지웠습니다."); } catch (err) { errEl.textContent = err.message; }
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
          h("button", { class: "off-x", "aria-label": `${fmtMonthDay(d.start)}${d.start === d.end ? "" : `~${fmtMonthDay(d.end)}`}${d.memo ? ` ${d.memo}` : ""} 삭제`, on: { click: async () => {
            try {
              await del(`/api/days-off/${d.id}`);
              await paint();
              await loadWeek();
              const { id, ...again } = d;
              toast(`쉬는 날(${fmtMonthDay(d.start)}${d.start === d.end ? "" : `~${fmtMonthDay(d.end)}`})을 지웠습니다.`, {
                action: { label: "되돌리기", fn: async () => { try { await post("/api/days-off", again); await paint(); await loadWeek(); } catch (err) { toastError(err); } } },
              });
            } catch (err) { errEl.textContent = err.message; }
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
