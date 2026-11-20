// 시간표 화면: 회차(행) × 요일(열) 표, 오른쪽에 지금 패널과 선택한 칸 패널
import { del, get, post, put } from "../api.js";
import {
  WEEKDAYS, addDays, confirmDialog, fmtClock, fmtDate, fmtDuration, fmtIn, fmtMonthDay, fmtWeekTitle,
  h, icon, openDialog, stepBar, toast, toastError, weekdaySummary,
} from "../ui.js";

let ctx, root, mainEl, nowEl, selEl;
const st = { start: null, week: null, selected: null, lastSkip: null, weekKey: "", loadToken: 0 };

export function mount(el, appCtx) {
  ctx = appCtx;
  root = el;
  mainEl = h("section", { "aria-label": "주간 시간표" }, h("div", { class: "skel" }));
  nowEl = h("div");
  selEl = h("div");
  el.replaceChildren(h("div", { class: "tt-page" }, mainEl, h("aside", { class: "rail", "aria-label": "지금" }, nowEl, selEl)));
  st.weekKey = weekKey(ctx.status);
  loadWeek();
  renderNow();
}

export function unmount() {
  root = null;
}

export function onStatus(status) {
  if (!root) return;
  renderNow();
  const key = weekKey(status);
  if (key !== st.weekKey) {
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
    if (token !== st.loadToken || !root) return;
    st.week = week;
    st.start = week.start;
    renderGrid();
    renderSel();
  } catch (err) {
    if (!root) return;
    mainEl.replaceChildren(
      h("div", { class: "card empty" },
        h("h3", null, "시간표를 불러오지 못했습니다"),
        h("p", null, err.message),
        h("button", { class: "btn", on: { click: loadWeek } }, "다시 시도"),
      ),
    );
  }
}

async function refreshAfterChange(message) {
  if (message) toast(message);
  await loadWeek();
}

// 시간표 ------------------------------------------------------------------------
function isThisWeek() {
  const today = ctx.status?.now.slice(0, 10);
  return st.week?.days.some((d) => d.date === today);
}

function renderGrid() {
  const w = st.week;
  const first = w.days[0].date;
  const last = w.days.at(-1).date;
  const bar = h("div", { class: "weekbar" },
    h("button", { class: "ibtn", "aria-label": "지난주", on: { click: () => changeWeek(-7) } }, icon("left")),
    h("button", { class: "ibtn", "aria-label": "다음 주", on: { click: () => changeWeek(7) } }, icon("right")),
    h("h2", null, fmtWeekTitle(first, last)),
    h("button", { class: "btn sm", disabled: isThisWeek(), on: { click: () => { st.start = null; loadWeek(); } } }, "이번 주"),
    h("button", { class: "btn sm ghost", on: { click: () => openDaysOffDialog() } }, icon("calendarOff"), "쉬는 날"),
    h("div", { class: "legend", "aria-hidden": "true" },
      h("span", null, h("i", { class: "lg-done" }), "완료"),
      h("span", null, h("i", { class: "lg-chg" }), "이 날만 변경"),
      h("span", null, h("i", { class: "lg-off" }), "쉼"),
    ),
  );

  if (!w.rows.length) {
    const noPrograms = !ctx.programs.length;
    mainEl.replaceChildren(bar,
      h("div", { class: "card empty" },
        h("h3", null, "아직 회차가 없습니다"),
        h("p", null, noPrograms
          ? "먼저 방송 구성(음성 안내와 음악 순서)을 만든 뒤, 언제 내보낼지 회차를 추가하세요."
          : "회차를 추가하면 정해진 요일·시각에 방송 구성을 자동으로 내보냅니다."),
        noPrograms
          ? h("button", { class: "btn pri", on: { click: () => ctx.go("programs") } }, "방송 구성 만들기")
          : h("button", { class: "btn pri", on: { click: () => openSlotDialog(null) } }, icon("plus"), "회차 추가"),
      ),
    );
    return;
  }

  const grid = h("div", { class: "tt", role: "grid", "aria-label": "주간 시간표", style: { gridTemplateColumns: `120px repeat(${w.days.length}, minmax(0, 1fr))` } });
  grid.append(h("div", { class: "corner" }));
  for (const day of w.days) {
    const sel = st.selected?.type === "day" && st.selected.date === day.date;
    grid.append(
      h("button", {
        class: `dayhd${day.is_today ? " today" : ""}${sel ? " sel" : ""}`,
        "aria-label": `${fmtDate(day.date)}${day.day_off ? ", 쉬는 날" : ""}`,
        on: { click: () => select({ type: "day", date: day.date }) },
      },
        h("b", null, day.label),
        h("small", null, `${fmtMonthDay(day.date)}${day.is_today ? " 오늘" : ""}${day.day_off ? ` · 쉼${day.day_off.memo ? ` ${day.day_off.memo}` : ""}` : ""}`),
      ),
    );
  }
  for (const row of w.rows) {
    const slot = row.slot;
    grid.append(
      h("div", { class: `rowhd${slot.enabled ? "" : " disabled"}` },
        h("b", null, slot.name),
        h("span", null, `${slot.time} · ${weekdaySummary(slot.weekdays)}${slot.enabled ? "" : " · 꺼짐"}`),
        h("button", { class: "link", on: { click: () => openSlotDialog(slot) } }, "매주 일정 편집"),
      ),
    );
    row.cells.forEach((cell, i) => grid.append(renderCell(row, cell, w.days[i])));
  }
  grid.append(h("div", { class: "addrow" }, h("button", { class: "link", on: { click: () => openSlotDialog(null) } }, icon("plus"), " 회차 추가")));
  mainEl.replaceChildren(bar, grid);
}

const STATUS_LABEL = { done: "완료", failed: "실패", missed: "방송 안 함", off: "쉼", next: "다음", live: "방송 중", scheduled: "예정" };

function renderCell(row, cell, day) {
  const today = day.is_today ? " today" : "";
  if (cell.status === "none") return h("div", { class: `cell none${today}` });
  const sel = st.selected?.type === "cell" && st.selected.date === cell.date && st.selected.slot_id === row.slot.id;
  const changed = cell.changed && cell.status !== "off";
  const cls = `cell ${cell.status}${changed ? " chg" : ""}${today}${sel ? " sel" : ""}`;

  let detail = cell.summary;
  if (cell.status === "off") detail = cell.override?.action === "skip" ? "이 날만 쉼" : `쉬는 날${day.day_off?.memo ? ` · ${day.day_off.memo}` : ""}`;
  else if (cell.status === "live") detail = liveProgress();
  else if (changed) {
    const parts = ["이 날만 변경"];
    if (cell.time !== cell.original_time) parts.push(`원래 ${cell.original_time}`);
    if (cell.program_id !== row.slot.program_id) parts.push(cell.program_name);
    detail = parts.join(" · ");
  }

  const label = h("span", { class: "st" },
    cell.status === "done" ? icon("check") : cell.status === "live" ? h("span", { class: "dot" }) : null,
    STATUS_LABEL[cell.status],
  );
  return h("div", { class: cls, role: "gridcell" },
    h("button", {
      "aria-label": `${fmtDate(cell.date)} ${row.slot.name} ${cell.time}, ${STATUS_LABEL[cell.status]}`,
      "aria-pressed": sel ? "true" : "false",
      on: { click: () => select({ type: "cell", date: cell.date, slot_id: row.slot.id }) },
    },
      h("span", { class: "l1" },
        h("span", { class: "t" }, cell.time),
        label,
      ),
      h("span", { class: "p" }, detail),
    ),
  );
}

function liveProgress() {
  const r = ctx.status?.runner;
  if (!r?.plays) return "";
  return `${r.index + 1}/${r.plays.length}단계 · ${r.plays[r.index]?.label ?? ""}`;
}

function changeWeek(days) {
  st.start = addDays(st.week.start, days);
  loadWeek();
}

function select(sel) {
  st.selected = sel;
  renderGrid();
  renderSel();
}

// 지금 패널 ---------------------------------------------------------------------
function renderNow() {
  const status = ctx.status;
  if (!status || !nowEl) return;
  const focusKey = nowEl.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
  paintNow(status);
  if (focusKey) nowEl.querySelector(`[data-focus="${focusKey}"]`)?.focus();
}

function paintNow(status) {
  const r = status.runner;
  if (r.state !== "idle" && r.kind !== "preview") return nowEl.replaceChildren(liveCard(r));
  if (r.state !== "idle" && r.kind === "preview") {
    return nowEl.replaceChildren(
      h("section", { class: "card" },
        h("div", { class: "ck" }, h("span", null, "미리듣기 중")),
        h("button", { class: "btn", "data-focus": "stop-preview", on: { click: stopBroadcast } }, icon("stop"), "미리듣기 정지"),
      ),
    );
  }
  nowEl.replaceChildren(nextCard(status));
}

function liveCard(r) {
  const plays = r.plays || [];
  const before = plays.slice(0, r.index).reduce((a, p) => a + p.seconds, 0);
  const cur = plays[r.index];
  const curElapsed = Math.min(r.play_elapsed || 0, cur?.seconds || 0);
  const total = plays.reduce((a, p) => a + p.seconds, 0);
  const stateText = { preparing: "다른 소리를 멈추는 중", restoring: "원래 소리로 되돌리는 중" }[r.state];
  return h("section", { class: "card liveC", "aria-live": "polite" },
    h("div", { class: "ck" },
      h("span", { class: "liv" }, h("span", { class: "dot" }), stateText || "방송 중"),
      h("span", null, `${fmtClock(before + curElapsed)} / ${fmtClock(total)}`),
    ),
    h("span", { class: "nm" }, r.name),
    stepBar(plays, { index: r.state === "playing" ? r.index : r.state === "restoring" ? plays.length : -1, ratio: cur?.seconds ? curElapsed / cur.seconds : 0 }),
    h("ol", { class: "units" },
      plays.map((p, i) =>
        h("li", { class: i < r.index ? "past" : i === r.index && r.state === "playing" ? "cur" : "" },
          h("span", { class: "n" }, i + 1), h("span", null, p.label), h("span", null, fmtClock(p.seconds)),
        ),
      ),
    ),
    h("div", { class: "btns" },
      h("button", { class: "btn", "data-focus": "skip", disabled: r.state !== "playing", on: { click: skipStep } }, icon("skip"), "다음 단계로"),
      h("button", { class: "btn stop", "data-focus": "stop", disabled: r.state === "restoring", on: { click: stopBroadcast } }, icon("stop"), "방송 끄기"),
    ),
    h("p", { class: "hint" }, "방송이 끝나거나 끄면 멈췄던 영상·음악과 음량을 원래대로 되돌립니다."),
  );
}

function nextCard(status) {
  const n = status.next;
  const skip = st.lastSkip && Date.now() - st.lastSkip.at < 60000 ? st.lastSkip : null;
  const notice = skip
    ? h("div", { class: "notice" },
        h("span", null, `${skip.dateLabel} ${skip.time} ${skip.name}을(를) 껐습니다`),
        h("button", { class: "link", "data-focus": "undo", on: { click: undoSkip } }, "되돌리기"))
    : null;
  if (!n) {
    return h("section", { class: "card" }, notice,
      h("div", { class: "ck" }, h("span", null, "다음 방송")),
      h("span", { class: "nm" }, "예정된 방송이 없습니다"),
      h("p", { class: "hint" }, status.auto_broadcast ? "시간표에 회차를 추가하면 여기에 다음 방송이 보입니다." : "자동 방송이 꺼져 있습니다."),
    );
  }
  const today = status.now.slice(0, 10);
  const when = n.date === today ? fmtIn(n.in_seconds) : fmtDate(n.date);
  return h("section", { class: "card" }, notice,
    h("div", { class: "ck" }, h("span", null, "다음 방송"), h("span", null, when)),
    h("span", { class: "bigt" }, n.time),
    h("span", { class: "nm" }, n.name),
    stepBar(n.units, { preview: true }),
    h("span", { class: "meta" }, `${n.summary} · 약 ${fmtDuration(n.seconds)}`),
    h("div", { class: "btns" },
      h("button", { class: "btn pri", "data-focus": "now", on: { click: () => broadcastNow(n) } }, icon("play"), "지금 방송"),
      h("button", { class: "btn", "data-focus": "skip-next", on: { click: skipNext } }, "이번 방송 끄기"),
    ),
    h("p", { class: "hint" }, `끄면 ${n.date === today ? "오늘" : fmtDate(n.date)} ${n.time} 방송만 쉽니다. 다음 주 일정은 그대로입니다.`),
  );
}

async function broadcastNow(n) {
  try {
    await post("/api/broadcast", { program_id: n.program_id });
    toast("방송을 시작합니다. 다른 앱 소리를 잠시 멈춥니다.");
  } catch (err) {
    toastError(err);
  }
}

async function stopBroadcast() {
  try {
    await post("/api/broadcast/stop");
    toast("방송을 껐습니다. 다른 앱 소리를 원래대로 되돌립니다.");
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
    st.lastSkip = { ...res, dateLabel: res.date === ctx.status.now.slice(0, 10) ? "오늘" : fmtDate(res.date), at: Date.now() };
    await refreshAfterChange(`${st.lastSkip.dateLabel} ${res.time} ${res.name}을(를) 껐습니다.`);
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
    await refreshAfterChange("되돌렸습니다.");
  } catch (err) {
    toastError(err);
  }
}

// 선택한 칸 패널 ------------------------------------------------------------------
function renderSel() {
  if (!selEl) return;
  const sel = st.selected;
  if (!sel || !st.week) {
    selEl.replaceChildren(
      h("section", { class: "card" },
        h("div", { class: "ck" }, h("span", null, "선택한 칸")),
        h("p", { class: "hint" }, "시간표의 칸을 누르면 그 날짜만 쉬거나 시각·구성을 바꿀 수 있습니다. 요일 머리글을 누르면 하루를 통째로 쉬게 할 수 있습니다."),
      ),
    );
    return;
  }
  if (sel.type === "day") return selEl.replaceChildren(dayCard(sel));
  const row = st.week.rows.find((r) => r.slot.id === sel.slot_id);
  const idx = st.week.days.findIndex((d) => d.date === sel.date);
  const cell = row?.cells[idx];
  if (!cell || cell.status === "none") {
    st.selected = null;
    return renderSel();
  }
  selEl.replaceChildren(cellCard(row, cell, st.week.days[idx]));
}

function cellCard(row, cell, day) {
  const title = `${fmtDate(cell.date)} · ${row.slot.name}`;
  const past = ["done", "failed", "missed", "live"].includes(cell.status);
  if (past) {
    return h("section", { class: "card" },
      h("div", { class: "ck" }, h("span", null, "선택한 칸")),
      h("span", { class: "nm", style: { fontSize: "15px" } }, title),
      h("p", { class: "meta", style: { margin: 0 } }, cell.status === "live" ? "지금 방송 중인 회차입니다." : "지난 회차라 바꿀 수 없습니다."),
    );
  }
  const ov = cell.override;
  let mode = ov ? (ov.action === "skip" ? "skip" : "change") : "keep";
  let timeInput, programSelect, errEl, fieldsEl;
  const radios = h("div", { class: "radios", role: "radiogroup", "aria-label": "이 날 이 회차" });
  const options = [["keep", "그대로"], ["skip", "쉬기"], ["change", "바꾸기"]];
  const paintRadios = () => {
    radios.replaceChildren(
      ...options.map(([value, label]) =>
        h("button", { role: "radio", "aria-checked": String(mode === value), on: { click: () => choose(value) } }, label),
      ),
    );
    fieldsEl.hidden = mode !== "change";
  };
  const choose = async (value) => {
    if (value === "change") {
      mode = "change";
      paintRadios();
      timeInput.focus();
      return;
    }
    try {
      if (value === "keep") {
        if (ov) await del(`/api/overrides/${cell.date}/${row.slot.id}`);
        mode = "keep";
        await refreshAfterChange("원래 일정대로 방송합니다.");
      } else {
        await put("/api/overrides", { date: cell.date, slot_id: row.slot.id, action: "skip" });
        mode = "skip";
        await refreshAfterChange(`${fmtDate(cell.date)} ${row.slot.name}을(를) 쉽니다.`);
      }
    } catch (err) {
      toastError(err);
    }
  };
  const saveChange = async () => {
    errEl.textContent = "";
    if (!timeInput.value) {
      errEl.textContent = "시각을 입력하세요.";
      timeInput.setAttribute("aria-invalid", "true");
      return;
    }
    try {
      await put("/api/overrides", { date: cell.date, slot_id: row.slot.id, action: "change", time: timeInput.value, program_id: programSelect.value });
      await refreshAfterChange(`${fmtDate(cell.date)} ${row.slot.name}을(를) ${timeInput.value}에 방송합니다.`);
    } catch (err) {
      errEl.textContent = err.message;
    }
  };
  const id = `sel-${cell.date}-${row.slot.id}`;
  fieldsEl = h("div", { style: { display: "grid", gap: "var(--s3)" } },
    h("div", { class: "fields" },
      h("label", { class: "lbl", for: `${id}-time` }, "시각"),
      (timeInput = h("input", { class: "input", type: "time", id: `${id}-time`, value: ov?.time || cell.time, required: true })),
      h("label", { class: "lbl", for: `${id}-prog` }, "구성"),
      (programSelect = h("select", { class: "input", id: `${id}-prog` },
        ctx.programs.map((p) => h("option", { value: p.id, selected: p.id === (ov?.program_id || cell.program_id) }, p.name)))),
    ),
    (errEl = h("p", { class: "err", role: "alert" })),
    h("button", { class: "btn pri", on: { click: saveChange } }, "이 날짜에 적용"),
  );
  paintRadios();
  return h("section", { class: "card" },
    h("div", { class: "ck" }, h("span", null, "선택한 칸")),
    h("span", { class: "nm", style: { fontSize: "15px" } }, title),
    day.day_off && !ov ? h("p", { class: "hint" }, `이 날은 쉬는 날${day.day_off.memo ? `(${day.day_off.memo})` : ""}입니다. 바꾸기로 지정하면 이 회차만 방송합니다.`) : null,
    radios,
    fieldsEl,
    h("p", { class: "hint" }, "이 날짜에만 적용됩니다. 매주 바꾸려면 회차의 '매주 일정 편집'을 누르세요."),
  );
}

function dayCard(sel) {
  const day = st.week.days.find((d) => d.date === sel.date);
  if (!day) return h("div");
  const off = day.day_off;
  if (off) {
    const range = off.start !== off.end;
    return h("section", { class: "card" },
      h("div", { class: "ck" }, h("span", null, "선택한 날")),
      h("span", { class: "nm", style: { fontSize: "15px" } }, fmtDate(day.date)),
      h("p", { class: "meta", style: { margin: 0 } },
        `쉬는 날${off.memo ? ` · ${off.memo}` : ""}${range ? ` (${fmtDate(off.start)} ~ ${fmtDate(off.end)})` : ""}`),
      h("button", {
        class: "btn",
        on: { click: async () => {
          if (range && !(await confirmDialog({ title: "쉬는 기간 해제", message: `${fmtDate(off.start)} ~ ${fmtDate(off.end)} 기간 전체를 해제합니다.`, confirm: "기간 해제" }))) return;
          try {
            await del(`/api/days-off/${off.id}`);
            await refreshAfterChange("쉬는 날을 해제했습니다.");
          } catch (err) {
            toastError(err);
          }
        } },
      }, range ? "기간 전체 해제" : "쉬는 날 해제"),
    );
  }
  let memo;
  return h("section", { class: "card" },
    h("div", { class: "ck" }, h("span", null, "선택한 날")),
    h("span", { class: "nm", style: { fontSize: "15px" } }, fmtDate(day.date)),
    h("label", { class: "field" }, h("span", null, "메모 (선택)"), (memo = h("input", { class: "input", maxlength: 60, placeholder: "예: 개교기념일" }))),
    h("button", {
      class: "btn pri",
      on: { click: async () => {
        try {
          await post("/api/days-off", { start: day.date, end: day.date, memo: memo.value.trim() });
          await refreshAfterChange(`${fmtDate(day.date)}은(는) 방송하지 않습니다.`);
        } catch (err) {
          toastError(err);
        }
      } },
    }, "이 날 쉬기"),
    h("button", { class: "link", style: { justifySelf: "start" }, on: { click: () => openDaysOffDialog(day.date) } }, "여러 날 쉬기…"),
  );
}

// 회차 대화상자 ---------------------------------------------------------------------
function openSlotDialog(slot) {
  if (!ctx.programs.length) {
    toast("먼저 방송 구성을 만드세요.");
    ctx.go("programs");
    return;
  }
  const isNew = !slot;
  const draft = slot ? { ...slot, weekdays: [...slot.weekdays] } : { name: "", time: "09:00", weekdays: [0, 1, 2, 3, 4], program_id: ctx.programs[0].id, enabled: true };
  let nameEl, timeEl, progEl, enabledEl, errEl, dayBox, confirmBox;

  const paintDays = () =>
    dayBox.replaceChildren(
      ...WEEKDAYS.map((label, i) =>
        h("button", {
          type: "button",
          "aria-pressed": String(draft.weekdays.includes(i)),
          on: { click: () => {
            draft.weekdays = draft.weekdays.includes(i) ? draft.weekdays.filter((d) => d !== i) : [...draft.weekdays, i];
            paintDays();
          } },
        }, label),
      ),
    );

  const { close } = openDialog(isNew ? "회차 추가" : "회차 편집", (close) => {
    const form = h("form", { class: "dlg", on: { submit: (e) => { e.preventDefault(); save(); } } },
      h("h2", null, isNew ? "회차 추가" : "매주 일정 편집"),
      h("label", { class: "field" }, h("span", null, "이름"), (nameEl = h("input", { class: "input", value: draft.name, maxlength: 40, placeholder: "예: 점심 안내", required: true }))),
      h("label", { class: "field" }, h("span", null, "시각"), (timeEl = h("input", { class: "input", type: "time", value: draft.time, required: true }))),
      h("div", { class: "field" }, h("span", null, "요일"), (dayBox = h("div", { class: "toggles", role: "group", "aria-label": "요일" }))),
      h("label", { class: "field" }, h("span", null, "방송 구성"),
        (progEl = h("select", { class: "input" }, ctx.programs.map((p) => h("option", { value: p.id, selected: p.id === draft.program_id }, `${p.name} · ${p.summary}`))))),
      h("label", { style: { display: "flex", gap: "var(--s2)", alignItems: "center" } },
        (enabledEl = h("input", { type: "checkbox", checked: draft.enabled, style: { width: "18px", height: "18px", accentColor: "var(--accent)" } })),
        "이 회차 사용"),
      (errEl = h("p", { class: "err", role: "alert" })),
      (confirmBox = h("div", { hidden: true })),
      h("div", { class: "dlg-foot" },
        isNew ? null : h("button", { type: "button", class: "btn danger", on: { click: askDelete } }, icon("trash"), "삭제"),
        h("span", { class: "grow" }),
        h("button", { type: "button", class: "btn", on: { click: () => close() } }, "취소"),
        h("button", { type: "submit", class: "btn pri" }, "저장"),
      ),
    );
    return form;
  });
  paintDays();
  nameEl.focus();

  async function save() {
    errEl.textContent = "";
    const body = { name: nameEl.value.trim(), time: timeEl.value, weekdays: draft.weekdays, program_id: progEl.value, enabled: enabledEl.checked };
    if (!body.name) return (errEl.textContent = "이름을 입력하세요.");
    if (!body.time) return (errEl.textContent = "시각을 입력하세요.");
    if (!body.weekdays.length) return (errEl.textContent = "요일을 하나 이상 고르세요.");
    try {
      if (isNew) await post("/api/slots", body);
      else await put(`/api/slots/${slot.id}`, body);
      close();
      await refreshAfterChange(isNew ? "회차를 추가했습니다." : "매주 일정을 바꿨습니다.");
    } catch (err) {
      errEl.textContent = err.message;
    }
  }

  function askDelete() {
    confirmBox.hidden = false;
    confirmBox.replaceChildren(
      h("div", { class: "confirm-row" },
        h("span", { class: "grow" }, "이 회차와 이 회차의 날짜별 예외를 지웁니다."),
        h("button", { type: "button", class: "btn sm", on: { click: () => (confirmBox.hidden = true) } }, "취소"),
        h("button", { type: "button", class: "btn sm stop", on: { click: doDelete } }, "지우기"),
      ),
    );
  }

  async function doDelete() {
    try {
      await del(`/api/slots/${slot.id}`);
      close();
      st.selected = null;
      await refreshAfterChange("회차를 지웠습니다.");
    } catch (err) {
      errEl.textContent = err.message;
    }
  }
}

// 쉬는 날 대화상자 -------------------------------------------------------------------
async function openDaysOffDialog(prefill) {
  let list, startEl, endEl, memoEl, errEl;
  const paint = async () => {
    try {
      const items = await get("/api/days-off");
      list.replaceChildren(
        ...(items.length
          ? items.map((d) =>
              h("div", { class: "notice" },
                h("span", null, `${d.start === d.end ? fmtDate(d.start) : `${fmtDate(d.start)} ~ ${fmtDate(d.end)}`}${d.memo ? ` · ${d.memo}` : ""}`),
                h("button", { class: "link", on: { click: async () => {
                  try {
                    await del(`/api/days-off/${d.id}`);
                    await paint();
                    await loadWeek();
                  } catch (err) {
                    errEl.textContent = err.message;
                  }
                } } }, "삭제"),
              ))
          : [h("p", { class: "hint" }, "등록한 쉬는 날이 없습니다.")]),
      );
    } catch (err) {
      errEl.textContent = err.message;
    }
  };
  const today = ctx.status.now.slice(0, 10);
  openDialog("쉬는 날", (close) =>
    h("div", { class: "dlg" },
      h("h2", null, "쉬는 날"),
      h("p", { class: "hint" }, "이 기간에는 모든 회차를 방송하지 않습니다. 특정 회차를 '바꾸기'로 지정하면 그 회차만 방송합니다."),
      (list = h("div", { style: { display: "grid", gap: "var(--s2)", maxHeight: "220px", overflow: "auto" } })),
      h("form", { style: { display: "grid", gap: "var(--s3)" }, on: { submit: async (e) => {
        e.preventDefault();
        errEl.textContent = "";
        if (!startEl.value || !endEl.value) return (errEl.textContent = "시작 날짜와 끝 날짜를 고르세요.");
        if (endEl.value < startEl.value) return (errEl.textContent = "끝 날짜가 시작 날짜보다 빠릅니다.");
        try {
          await post("/api/days-off", { start: startEl.value, end: endEl.value, memo: memoEl.value.trim() });
          memoEl.value = "";
          await paint();
          await loadWeek();
          toast("쉬는 날을 추가했습니다.");
        } catch (err) {
          errEl.textContent = err.message;
        }
      } } },
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s3)" } },
          h("label", { class: "field" }, h("span", null, "시작"), (startEl = h("input", { class: "input", type: "date", value: prefill || today, on: { change: () => { if (endEl.value < startEl.value) endEl.value = startEl.value; } } }))),
          h("label", { class: "field" }, h("span", null, "끝"), (endEl = h("input", { class: "input", type: "date", value: prefill || today }))),
        ),
        h("label", { class: "field" }, h("span", null, "메모 (선택)"), (memoEl = h("input", { class: "input", maxlength: 60, placeholder: "예: 겨울 방학" }))),
        (errEl = h("p", { class: "err", role: "alert" })),
        h("div", { class: "dlg-foot" },
          h("button", { type: "button", class: "btn", on: { click: () => close() } }, "닫기"),
          h("button", { type: "submit", class: "btn pri" }, "추가"),
        ),
      ),
    ),
  );
  await paint();
}
