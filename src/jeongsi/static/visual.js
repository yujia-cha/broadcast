// 그림으로 보여 주고 직접 만져서 조작하는 부품들
import { WEEKDAYS, addDays, h, icon, isoDate, parseDate } from "./ui.js";

// 방송 구성 띠 ---------------------------------------------------------------------
// steps: [{kind, repeat}] 또는 units: [{kind, seconds}] → 음성은 말풍선, 음악은 음표 블록으로 이어 붙인다
export function strip(items, { size = "md", index = -1, ratio = 0, expanded = true } = {}) {
  const blocks = [];
  for (const item of items) {
    const count = expanded ? item.repeat ?? 1 : 1;
    for (let i = 0; i < count; i++) blocks.push({ kind: item.kind, seconds: item.seconds });
  }
  return h("span", { class: `strip strip-${size}`, role: "img", "aria-label": describe(items) },
    blocks.map((b, i) => {
      const el = h("span", { class: `blk blk-${b.kind}${i < index ? " done" : ""}${i === index ? " cur" : ""}` }, icon(b.kind === "tts" ? "speech" : "music"));
      if (i === index) el.append(h("b", { class: "blk-fill", style: { width: `${Math.round(Math.min(1, ratio) * 100)}%` } }));
      return el;
    }),
  );
}

export function describe(items) {
  return items.map((s) => `${s.kind === "tts" ? "음성" : "음악"}${(s.repeat ?? 1) > 1 ? ` ${s.repeat}번` : ""}`).join(", ");
}

// 요일 점 ---------------------------------------------------------------------------
export function dayDots(weekdays) {
  return h("span", { class: "daydots", role: "img", "aria-label": weekdays.map((d) => WEEKDAYS[d]).join(", ") },
    WEEKDAYS.map((label, i) => h("i", { class: weekdays.includes(i) ? "on" : "" }, label)));
}

// 요일 고르기: 동그라미 7개 + 평일·매일 묶음 ------------------------------------------------
export function weekdayPicker(selected, onChange) {
  let value = [...selected];
  const wrap = h("div", { class: "wdp" });
  const paint = () => {
    const presets = [["평일", [0, 1, 2, 3, 4]], ["매일", [0, 1, 2, 3, 4, 5, 6]]];
    wrap.replaceChildren(
      h("div", { class: "wdp-days", role: "group", "aria-label": "요일" },
        WEEKDAYS.map((label, i) =>
          h("button", { class: "wdp-day", "aria-pressed": String(value.includes(i)), on: { click: () => {
            value = value.includes(i) ? value.filter((x) => x !== i) : [...value, i].sort();
            paint();
            onChange(value, false);
          } } }, label))),
      h("div", { class: "wdp-presets" },
        presets.map(([label, days]) => {
          const active = days.length === value.length && days.every((d) => value.includes(d));
          return h("button", { class: "chip-btn", "aria-pressed": String(active), on: { click: () => { value = [...days]; paint(); onChange(value, true); } } },
            dayDots(days), label);
        })),
    );
  };
  paint();
  return wrap;
}

// 시각 고르기: 큰 숫자 + 하루 눈금자 위 핀 끌기 ---------------------------------------------
const pad = (n) => String(n).padStart(2, "0");
export const toMinutes = (hhmm) => (hhmm ? Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) : null);
export const toHHMM = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;

export function timePicker(value, onChange, { from = 6 * 60, to = 22 * 60 } = {}) {
  let minutes = toMinutes(value) ?? 12 * 60;
  const display = h("div", { class: "tp-display" });
  const pin = h("button", { class: "tp-pin", role: "slider", "aria-label": "시각", "aria-valuemin": 0, "aria-valuemax": 1435 });
  const track = h("div", { class: "tp-track" },
    Array.from({ length: (to - from) / 60 + 1 }, (_, i) => {
      const hour = from / 60 + i;
      return h("span", { class: "tp-tick", style: { left: `${(i * 60 * 100) / (to - from)}%` } }, hour % 3 === 0 ? String(hour) : "");
    }),
    pin,
  );
  const set = (m, done = false) => {
    minutes = ((Math.round(m / 5) * 5) % 1440 + 1440) % 1440;
    const hhmm = toHHMM(minutes);
    display.replaceChildren(
      stepBtn("up", "1시간 늦게", () => set(minutes + 60)),
      h("span", { class: "tp-time" }, hhmm),
      stepBtn("down", "1시간 일찍", () => set(minutes - 60)),
    );
    const clamped = Math.min(to, Math.max(from, minutes));
    pin.style.left = `${((clamped - from) * 100) / (to - from)}%`;
    pin.setAttribute("aria-valuenow", String(minutes));
    pin.setAttribute("aria-valuetext", hhmm);
    onChange(hhmm, done);
  };
  const fromPointer = (e) => {
    const r = track.getBoundingClientRect();
    set(from + ((e.clientX - r.left) / r.width) * (to - from));
  };
  track.addEventListener("pointerdown", (e) => {
    track.setPointerCapture(e.pointerId);
    fromPointer(e);
    const move = (ev) => fromPointer(ev);
    const up = () => { track.removeEventListener("pointermove", move); track.removeEventListener("pointerup", up); pin.focus(); };
    track.addEventListener("pointermove", move);
    track.addEventListener("pointerup", up);
  });
  pin.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: 60, PageDown: -60 }[e.key];
    if (step) { e.preventDefault(); set(minutes + step); }
    if (e.key === "Enter") { e.preventDefault(); onChange(toHHMM(minutes), true); }
  });
  const wrap = h("div", { class: "tp" }, display, h("div", { class: "tp-scale" }, icon("sun"), track, icon("moon")));
  set(minutes);
  return wrap;
}

function stepBtn(dir, label, fn) {
  return h("button", { class: "ibtn tp-step", "aria-label": label, on: { click: fn } }, icon(dir));
}

// 횟수 고르기: 아이콘을 몇 개 켤지 -------------------------------------------------------
export function countPicker(kind, value, onPick, max = 5) {
  const items = Array.from({ length: max }, (_, i) =>
    h("button", { class: `cp-item blk blk-${kind}`, role: "radio", "aria-label": `${i + 1}번` },
      icon(kind === "tts" ? "speech" : "music"), h("small", null, `${i + 1}`)));
  // 버튼은 한 번만 만들고 켜짐 표시만 바꾼다(다시 만들면 누르는 중에 버튼이 사라진다)
  const paint = (lit = value) => items.forEach((el, i) => {
    el.classList.toggle("on", i + 1 <= (lit ?? 0));
    el.setAttribute("aria-checked", String(value === i + 1));
  });
  items.forEach((el, i) => {
    el.addEventListener("click", () => { value = i + 1; paint(); onPick(value); });
    el.addEventListener("mouseenter", () => paint(i + 1));
    el.addEventListener("focus", () => paint(i + 1));
  });
  const row = h("div", { class: "cp", role: "radiogroup", "aria-label": "횟수", on: { mouseleave: () => paint() } }, items);
  paint();
  return row;
}

// 기간 고르기: 달력에서 시작·끝 누르기, 끝 없음은 ∞ -----------------------------------------
export function rangeCalendar({ start, end, min, allowOpen = true }, onChange) {
  let s = start || min;
  let e = end || (allowOpen ? null : s);
  let open = allowOpen && !end; // 끝 없음
  let month = parseDate(s);
  month.setDate(1);
  let picking = "start";
  const wrap = h("div", { class: "rc" });
  const paint = () => {
    const first = new Date(month);
    const offset = (first.getDay() + 6) % 7;
    const days = [];
    for (let i = 0; i < offset; i++) days.push(h("span"));
    const last = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    for (let d = 1; d <= last; d++) {
      const iso = isoDate(new Date(month.getFullYear(), month.getMonth(), d));
      const disabled = iso < min;
      const inRange = iso >= s && (open ? true : iso <= e);
      const cls = ["rc-day", inRange ? "in" : "", iso === s ? "start" : "", !open && iso === e ? "end" : ""].join(" ");
      days.push(h("button", { class: cls, disabled, "aria-label": iso, "aria-pressed": String(iso === s || (!open && iso === e)), on: { click: () => pick(iso) } }, String(d)));
    }
    wrap.replaceChildren(
      h("div", { class: "rc-head" },
        h("button", { class: "ibtn", "aria-label": "이전 달", on: { click: () => { month.setMonth(month.getMonth() - 1); paint(); } } }, icon("left")),
        h("b", null, `${month.getFullYear()}년 ${month.getMonth() + 1}월`),
        h("button", { class: "ibtn", "aria-label": "다음 달", on: { click: () => { month.setMonth(month.getMonth() + 1); paint(); } } }, icon("right")),
      ),
      h("div", { class: "rc-grid" }, WEEKDAYS.map((w) => h("span", { class: "rc-w" }, w)), days),
      h("div", { class: "rc-foot" },
        h("span", { class: "rc-pill start" }, icon("play"), labelOf(s)),
        h("span", { class: "rc-arrow", "aria-hidden": "true" }, "→"),
        allowOpen ? h("button", { class: `rc-pill${open ? " on" : ""}`, "aria-pressed": String(open), "aria-label": "끝 없이 계속", on: { click: () => { open = true; e = null; picking = "start"; paint(); emit(); } } }, icon("infinity")) : null,
        open ? null : h("span", { class: "rc-pill end" }, icon("stop"), labelOf(e)),
      ),
    );
  };
  const labelOf = (iso) => { const d = parseDate(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const emit = () => onChange({ start: s, end: open ? null : e });
  const pick = (iso) => {
    if (picking === "start" || iso < s) {
      s = iso; picking = "end";
      if (allowOpen) { open = true; e = null; } else { e = iso; }
    } else {
      e = iso; open = false; picking = "start";
    }
    paint();
    emit();
  };
  paint();
  return wrap;
}

// 오늘 눈금자: 하루 중 방송 위치와 지금 ---------------------------------------------------
export function dayRuler(times, nowMinutes, nextTime) {
  const mins = times.map(toMinutes);
  const from = Math.min(7 * 60, ...mins.map((m) => Math.floor(m / 60) * 60));
  const to = Math.max(19 * 60, ...mins.map((m) => Math.ceil((m + 1) / 60) * 60));
  const pos = (m) => `${((Math.min(to, Math.max(from, m)) - from) * 100) / (to - from)}%`;
  return h("div", { class: "ruler", role: "img", "aria-label": `오늘 방송 ${times.join(", ")}` },
    h("i", { class: "ruler-past", style: { width: pos(nowMinutes) } }),
    mins.map((m, i) => h("span", { class: `ruler-dot${times[i] === nextTime ? " next" : ""}${m <= nowMinutes ? " past" : ""}`, style: { left: pos(m) } })),
    h("span", { class: "ruler-now", style: { left: pos(nowMinutes) } }),
    h("small", { class: "ruler-l" }, String(from / 60)),
    h("small", { class: "ruler-r" }, String(to / 60)),
  );
}

// 팝오버: 기준 요소 옆에 아이콘 버튼 묶음 ---------------------------------------------------
let openPop = null;
export function popover(anchor, content) {
  closePopover();
  const pop = h("div", { class: "pop", role: "dialog" }, content);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let left = r.left + r.width / 2 - pr.width / 2;
  left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, left));
  let top = r.bottom + 8;
  if (top + pr.height > window.innerHeight - 8) top = r.top - pr.height - 8;
  pop.style.left = `${left + window.scrollX}px`;
  pop.style.top = `${top + window.scrollY}px`;
  const onDoc = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const onKey = (e) => { if (e.key === "Escape") { closePopover(); anchor.focus(); } };
  setTimeout(() => document.addEventListener("pointerdown", onDoc), 0);
  document.addEventListener("keydown", onKey);
  openPop = { pop, cleanup: () => { document.removeEventListener("pointerdown", onDoc); document.removeEventListener("keydown", onKey); } };
  pop.querySelector("button")?.focus();
  return pop;
}

export function closePopover() {
  if (!openPop) return;
  openPop.cleanup();
  openPop.pop.remove();
  openPop = null;
}

// 아이콘 버튼(아이콘 + 짧은 이름) -----------------------------------------------------------
export function iconAction(name, label, onClick, { tone = "", disabled = false } = {}) {
  return h("button", { class: `ia ${tone}`, disabled, on: { click: onClick } }, h("span", { class: "ia-i" }, icon(name)), h("span", { class: "ia-l" }, label));
}

export { addDays };
