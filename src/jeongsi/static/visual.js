// 그림으로 보여 주고 직접 만져서 조작하는 부품들
import { WEEKDAYS, addDays, fmtDuration, h, icon, isoDate, parseDate } from "./ui.js";

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
          return h("button", { class: "chip-btn", "aria-label": label, "aria-pressed": String(active), on: { click: () => { value = [...days]; paint(); onChange(value, true); } } },
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
  let lo = from, hi = to;
  const earlier = stepBtn("left", "1시간 일찍", () => set(minutes - 60), false, "−1시간");
  const later = stepBtn("right", "1시간 늦게", () => set(minutes + 60), false, "+1시간");
  const timeText = h("input", {
    class: "tp-time", inputmode: "numeric", maxlength: 5, "aria-label": "시각 입력 (예: 0850)", autocomplete: "off",
    on: {
      focus: (e) => e.target.select(),
      keydown: (e) => {
        if (e.key === "Enter") { e.preventDefault(); const m = parseTyped(e.target.value); if (m !== null) set(m, true, true); else e.target.value = toHHMM(minutes); }
        if (e.key === "Escape") e.target.value = toHHMM(minutes);
      },
      blur: (e) => { const m = parseTyped(e.target.value); if (m !== null && m !== minutes) set(m, false, true); else if (m === null) e.target.value = toHHMM(minutes); },
    },
  });
  const display = h("div", { class: "tp-display" }, earlier, timeText, later); // 버튼을 다시 만들지 않아 초점이 남는다
  const pin = h("button", { class: "tp-pin", role: "slider", "aria-label": "시각", "aria-valuemin": 0, "aria-valuemax": 1435 });
  const tickBox = h("span", { class: "tp-ticks", "aria-hidden": "true" });
  const track = h("div", { class: "tp-track" }, tickBox, pin);
  let dragging = false;
  let painted = false;
  const ticks = () => {
    const every = hi - lo > 16 * 60 ? 6 : 3;
    tickBox.replaceChildren(...Array.from({ length: (hi - lo) / 60 + 1 }, (_, i) => {
      const hour = lo / 60 + i;
      return h("span", { class: "tp-tick", style: { left: `${(i * 60 * 100) / (hi - lo)}%` } }, hour % every === 0 ? String(hour) : "");
    }));
  };
  const set = (m, done = false, exact = false, silent = false) => {
    minutes = Math.min(exact ? 1439 : 1435, Math.max(0, exact ? Math.round(m) : Math.round(m / 5) * 5)); // 직접 입력은 분 단위 그대로
    // 기본 눈금(6~22시) 밖의 시각이면 하루 전체로 넓혀 핀이 거짓 위치에 붙지 않게 한다(끄는 중에는 눈금 고정)
    const [nlo, nhi] = minutes < from || minutes > to || hi - lo === 24 * 60 ? [0, 24 * 60] : [from, to]; // 한 번 넓히면 그대로
    if (!dragging && (nlo !== lo || nhi !== hi || !painted)) { lo = nlo; hi = nhi; painted = true; ticks(); }
    const hhmm = toHHMM(minutes);
    timeText.value = hhmm;
    earlier.disabled = minutes - 60 < 0;
    later.disabled = minutes + 60 > 1435;
    pin.style.left = `${((Math.min(hi, Math.max(lo, minutes)) - lo) * 100) / (hi - lo)}%`;
    pin.setAttribute("aria-valuenow", String(minutes));
    pin.setAttribute("aria-valuetext", hhmm);
    if (!silent) onChange(hhmm, done);
  };
  const fromPointer = (e) => {
    const r = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if ((ratio === 0 || ratio === 1) && hi - lo < 24 * 60) { lo = 0; hi = 24 * 60; ticks(); } // 끝에 닿으면 하루 전체로
    set(lo + ratio * (hi - lo));
  };
  track.addEventListener("pointerdown", (e) => {
    track.setPointerCapture(e.pointerId);
    dragging = true;
    fromPointer(e);
    const move = (ev) => fromPointer(ev);
    const up = () => {
      track.removeEventListener("pointermove", move); track.removeEventListener("pointerup", up);
      dragging = false;
      set(minutes);
      pin.focus();
    };
    track.addEventListener("pointermove", move);
    track.addEventListener("pointerup", up);
  });
  pin.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: 60, PageDown: -60 }[e.key];
    if (step) { e.preventDefault(); set(minutes + step); }
    if (e.key === "Home") { e.preventDefault(); set(0); }
    if (e.key === "End") { e.preventDefault(); set(1435); }
    if (e.key === "Enter") { e.preventDefault(); onChange(toHHMM(minutes), true); }
  });
  const wrap = h("div", { class: "tp" }, display, h("div", { class: "tp-scale" }, track));
  set(minutes, false, true, true);
  return wrap;
}

// "0850", "850", "8:50", "08:50", "8" → 분. 알아볼 수 없으면 null
export function parseTyped(text) {
  const t = String(text).trim().replace(/[.,\s]/g, ":");
  let hh, mm;
  if (/^\d{1,2}:\d{1,2}$/.test(t)) [hh, mm] = t.split(":").map(Number);
  else if (/^\d{3,4}$/.test(t)) { hh = Number(t.slice(0, -2)); mm = Number(t.slice(-2)); }
  else if (/^\d{1,2}$/.test(t)) { hh = Number(t); mm = 0; }
  else return null;
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

function stepBtn(dir, label, fn, disabled, text) {
  return h("button", { type: "button", class: "btn sm tp-step", "aria-label": label, disabled, on: { click: fn } },
    dir === "left" ? icon("left") : null, text, dir === "right" ? icon("right") : null);
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
  const onKey = (e) => {
    const i = items.indexOf(document.activeElement);
    const move = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (i < 0 || !move) return;
    e.preventDefault();
    items[Math.min(max - 1, Math.max(0, i + move))].focus();
  };
  const row = h("div", { class: "cp", role: "radiogroup", "aria-label": "횟수", on: { mouseleave: () => paint(), keydown: onKey } }, items);
  paint();
  return row;
}

// 기간 고르기: 달력에서 시작·끝 누르기, 끝 없음은 ∞. marked(날짜 → 이름)는 이미 정해 둔 날 -----------------
export function rangeCalendar({ start, end, min, allowOpen = true, marked = new Map(), view = null }, onChange) {
  let s = start || (allowOpen ? min : null);
  let e = end || (allowOpen ? null : s);
  let open = allowOpen && !end; // 끝 없음
  let month = parseDate(view || s || min); // view: 처음 보여 줄 달(그 달의 아무 날)
  month.setDate(1);
  let picking = s ? "end" : "start";
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
      const inRange = !!s && iso >= s && (open ? true : iso <= e);
      const mark = marked.get(iso);
      const cls = ["rc-day", inRange ? "in" : "", iso === s ? "start" : "", !open && iso === e ? "end" : "", mark !== undefined ? "marked" : ""].join(" ");
      days.push(h("button", { class: cls, disabled, title: mark || null, "data-date": iso, "aria-label": mark !== undefined ? `${spoken(iso)}, 이미 쉬는 날` : spoken(iso), "aria-pressed": String(iso === s || (!open && iso === e)), on: { click: () => pick(iso) } }, String(d)));
    }
    wrap.replaceChildren(
      h("div", { class: "rc-head" },
        h("button", { class: "ibtn", "aria-label": "이전 달", on: { click: () => { month.setMonth(month.getMonth() - 1); paint(); } } }, icon("left")),
        h("b", null, `${month.getFullYear()}년 ${month.getMonth() + 1}월`),
        h("button", { class: "ibtn", "aria-label": "다음 달", on: { click: () => { month.setMonth(month.getMonth() + 1); paint(); } } }, icon("right")),
      ),
      h("div", { class: "rc-grid" }, WEEKDAYS.map((w) => h("span", { class: "rc-w" }, w)), days),
      h("div", { class: "rc-foot" },
        h("span", { class: `rc-pill start${s ? "" : " empty"}` }, s ? labelOf(s) : "시작"),
        h("span", { class: "rc-arrow", "aria-hidden": "true" }, "→"),
        allowOpen ? h("button", { class: `rc-pill${open ? " on" : ""}`, "aria-pressed": String(open), "aria-label": "끝 없이 계속", on: { click: () => { open = true; e = null; picking = "start"; paint(); emit(); } } }, icon("infinity")) : null,
        open ? null : h("span", { class: `rc-pill end${e ? "" : " empty"}` }, e ? labelOf(e) : "끝"),
      ),
    );
  };
  const labelOf = (iso) => { const d = parseDate(iso); return `${d.getMonth() + 1}/${d.getDate()} ${WEEKDAYS[(d.getDay() + 6) % 7]}`; };
  const emit = () => onChange({ start: s, end: open ? null : e });
  const pick = (iso) => {
    if (!s || iso < s || (picking === "start" && !allowOpen)) {
      s = iso; picking = "end";
      if (allowOpen) { open = true; e = null; } else { e = iso; }
    } else {
      e = iso; open = false; picking = "end"; // 시작은 그대로, 끝만 옮긴다(시작을 바꾸려면 더 앞날을 누른다)
    }
    paint();
    emit();
  };
  paint();
  return wrap;
}

// 특정 날짜 여러 개 고르기: 달력에서 누를 때마다 켜고 끈다 ----------------------------------------
const DATE_STATE = { past: "지남", off: "쉬는 날" };
const spoken = (iso) => { const d = parseDate(iso); return `${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAYS[(d.getDay() + 6) % 7]}요일`; };
export function multiDateCalendar({ dates = [], min }, onChange) {
  let picked = new Set(dates);
  let states = {};
  let month = parseDate(dates.find((x) => x >= min) || min);
  month.setDate(1);
  const wrap = h("div", { class: "rc" });
  const short = (iso) => { const d = parseDate(iso); return `${d.getMonth() + 1}/${d.getDate()} ${WEEKDAYS[(d.getDay() + 6) % 7]}`; };
  const paint = () => {
    const offset = (month.getDay() + 6) % 7;
    const last = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const cells = Array.from({ length: offset }, () => h("span"));
    for (let d = 1; d <= last; d++) {
      const iso = isoDate(new Date(month.getFullYear(), month.getMonth(), d));
      const on = picked.has(iso);
      cells.push(h("button", { class: `rc-day${on ? " start" : ""}${on && DATE_STATE[states[iso]] ? " warn" : ""}`, disabled: iso < min, "data-date": iso, "aria-label": spoken(iso), "aria-pressed": String(on), on: { click: () => toggle(iso) } }, String(d)));
    }
    const sorted = [...picked].sort();
    wrap.replaceChildren(
      h("div", { class: "rc-head" },
        h("button", { class: "ibtn", "aria-label": "이전 달", on: { click: () => { month.setMonth(month.getMonth() - 1); paint(); } } }, icon("left")),
        h("b", null, `${month.getFullYear()}년 ${month.getMonth() + 1}월`),
        h("button", { class: "ibtn", "aria-label": "다음 달", on: { click: () => { month.setMonth(month.getMonth() + 1); paint(); } } }, icon("right")),
      ),
      h("div", { class: "rc-grid" }, WEEKDAYS.map((w) => h("span", { class: "rc-w" }, w)), cells),
      h("div", { class: "date-chips", "aria-live": "polite" },
        sorted.map((iso) => h("span", { class: `date-chip${DATE_STATE[states[iso]] ? ` ${states[iso]}` : ""}` }, short(iso),
          DATE_STATE[states[iso]] ? h("b", { class: "date-why" }, DATE_STATE[states[iso]]) : null,
          h("button", { class: "off-x", "aria-label": `${spoken(iso)} 빼기`, on: { click: () => toggle(iso) } }, icon("x"))))),
    );
  };
  const toggle = (iso) => {
    if (picked.has(iso)) picked.delete(iso); else picked.add(iso);
    paint();
    onChange([...picked].sort());
  };
  wrap.setStates = (next) => { states = next; paint(); }; // 날짜 → "ok" | "past" | "off"
  paint();
  return wrap;
}

export function dateChips(dates, max = 4, states = {}) {
  const short = (iso) => { const d = parseDate(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const shown = dates.slice(0, max).map((iso) => h("span", { class: DATE_STATE[states[iso]] ? "no" : null, title: DATE_STATE[states[iso]] || null }, short(iso)));
  const parts = shown.flatMap((el, i) => (i ? [" · ", el] : [el]));
  return h("span", { class: "dchips", "aria-label": dates.join(", ") }, icon("calendar"), ...parts, dates.length > max ? ` 외 ${dates.length - max}일` : "");
}

// 음악 파일 고르기: 올리기가 맨 위, 줄마다 듣기 버튼. collapse면 고른 파일만 보이고 펼쳐서 바꾼다 -------------
export function mediaPicker({ media, selected, onPick, onPreview, upload, collapse = false, label = "음악 파일" }) {
  let open = !collapse || !selected || media.length <= 3;
  const longest = Math.max(1, ...media.map((m) => m.seconds || 0));
  const wrap = h("div", { class: "wz-files" });
  const row = (m) => h("div", { class: "wz-file-row" },
    h("button", { class: "wz-file", role: "radio", "aria-checked": String(selected === m.name), on: { click: () => onPick(m) } },
      h("span", { class: "wz-file-i blk-audio" }, icon("music")),
      h("span", { class: "wz-file-n" }, m.display),
      h("span", { class: "wz-file-len" }, h("i", { style: { width: `${Math.max(6, ((m.seconds || 0) / longest) * 100)}%` } })),
      h("small", null, m.seconds ? fmtDuration(m.seconds) : "")),
    h("button", { class: "ibtn wz-file-play", "aria-label": `${m.display} 듣기`, on: { click: () => onPreview(m) } }, icon("play")));
  const paint = () => {
    const shown = open ? media : media.filter((m) => m.name === selected);
    wrap.replaceChildren(...[
      upload,
      h("div", { class: "wz-files", role: "radiogroup", "aria-label": label }, shown.map(row)),
      !collapse || !selected || media.length <= 3 ? null
        : open ? h("button", { class: "btn sm ghost wz-more", on: { click: () => { open = false; paint(); } } }, icon("up"), "접기")
        : h("button", { class: "btn sm ghost wz-more", on: { click: () => { open = true; paint(); } } }, icon("down"), `다른 파일 ${media.length - shown.length}개`),
    ].filter(Boolean));
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
    h("small", { class: "ruler-l" }, `${from / 60}시`),
    h("small", { class: "ruler-r" }, `${to / 60}시`),
  );
}

// 팝오버: 기준 요소 옆에 아이콘 버튼 묶음 ---------------------------------------------------
let openPop = null;
export function popover(anchor, content) {
  closePopover();
  const pop = h("div", { class: "pop", role: "dialog", tabindex: "-1" }, content);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let left = r.left + r.width / 2 - pr.width / 2;
  left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, left));
  let top = r.bottom + 8;
  if (top + pr.height > window.innerHeight - 8) top = r.top - pr.height - 8;
  pop.style.left = `${left + window.scrollX}px`;
  pop.style.top = `${top + window.scrollY}px`;
  // 닫힌 팝오버의 처리기가 남아 새 팝오버를 닫지 않도록, 지금 열린 팝오버일 때만 반응한다
  let alive = true;
  const onDoc = (e) => { if (openPop?.pop === pop && !pop.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const onKey = (e) => {
    if (openPop?.pop !== pop) return;
    if (e.key === "Escape") { closePopover(); anchor.focus(); return; }
    if (e.key === "Tab") { // 팝오버 안에서만 돈다(밖으로 빠지면 문서 끝으로 사라진다)
      const items = [...pop.querySelectorAll("button:not([disabled]), input, [tabindex='0']")];
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      e.preventDefault();
      items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
    }
  };
  setTimeout(() => { if (alive) document.addEventListener("pointerdown", onDoc); }, 0);
  document.addEventListener("keydown", onKey);
  openPop = { pop, cleanup: () => { alive = false; document.removeEventListener("pointerdown", onDoc); document.removeEventListener("keydown", onKey); } };
  // 첫 버튼(예: '지금')에 초점을 두면 Enter 두 번에 실행되므로 팝오버 자체에 둔다
  pop.focus();
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
