// 화면 공통 도우미: 요소 만들기, 아이콘, 알림, 대화상자, 날짜·시간 표시

const PROPS = new Set(["value", "checked", "disabled", "hidden", "selected", "readOnly", "multiple"]);

/** h("button", { class: "btn", on: { click } }, "저장") */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (tag === "button") el.type = "button"; // 폼 안의 부품 버튼이 저장(submit)을 일으키지 않게. 필요하면 type으로 바꾼다
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false && !PROPS.has(key)) continue;
    if (key === "class") el.className = value;
    else if (key === "on") for (const [ev, fn] of Object.entries(value)) el.addEventListener(ev, fn);
    else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
    else if (PROPS.has(key)) el[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

// lucide 아이콘(선 1.5). 신뢰할 수 있는 상수 문자열만 넣는다.
const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  play: '<path d="M7 5v14l12-7z"/>',
  skip: '<path d="m5 5 10 7-10 7z"/><path d="M19 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  speech: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  infinity: '<path d="M12 12c-2-2.7-4-4-6-4a4 4 0 0 0 0 8c2 0 4-1.3 6-4zm0 0c2 2.7 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.3-6 4z"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  upload: '<path d="M12 16V5"/><path d="m7 10 5-5 5 5"/><path d="M5 20h14"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/><path d="M8 15h2M14 15h2M8 18h2"/>',
  calendarOff: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/><path d="m9 15 6 4M15 15l-6 4"/>',
  alert: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
};

export function icon(name) {
  const wrap = document.createElement("span");
  wrap.innerHTML = `<svg class="i" viewBox="0 0 24 24" fill="${name === "stop" || name === "play" ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  return wrap.firstChild;
}

// 알림 -------------------------------------------------------------------------
let toastTimer;
/** action: { label, fn } — 토스트 안에 되돌리기 같은 버튼 하나를 둔다 */
// 한국어 조사: 마지막 글자의 받침으로 고른다(한글이 아니면 숫자 읽기 대신 뒤쪽 형태)
export function josa(word, pair) {
  const [withFinal, withoutFinal] = pair.split("/");
  const last = String(word).trim().replace(/['"’”)\]\s]+$/, "").slice(-1); // 따옴표·괄호 앞 글자로 판단
  const code = last.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return `${word}${withoutFinal}`;
  const final = code % 28;
  if (pair === "으로/로" && final === 8) return `${word}로`; // ㄹ받침은 '로'
  return `${word}${final ? withFinal : withoutFinal}`;
}

export function toast(message, { error = false, action = null } = {}) {
  const el = document.getElementById("toast");
  // 모달 대화상자가 열려 있으면 그 위(최상위 층)에 보이도록 대화상자 안으로 옮긴다
  const host = [...document.querySelectorAll("dialog[open]")].at(-1) || document.body;
  if (el.parentElement !== host) host.append(el);
  el.replaceChildren(h("span", null, message));
  if (action) {
    el.append(h("button", { class: "toast-act", on: { click: () => { el.classList.remove("show"); action.fn(); } } }, action.label));
  }
  el.classList.toggle("error", error);
  el.classList.toggle("has-action", !!action);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), error || action ? 6000 : 2600);
}

export function toastError(err) {
  toast(err?.message || String(err), { error: true });
}

// 대화상자 ----------------------------------------------------------------------
/** build(close)가 돌려준 요소를 모달로 띄운다. 닫히면 DOM에서 지운다. */
export function openDialog(label, build) {
  const opener = document.activeElement;
  const dialog = h("dialog", { "aria-label": label });
  const close = (value) => {
    const toastEl = dialog.querySelector("#toast"); // 대화상자 위에 띄웠던 알림은 지우지 않고 본문으로 돌려놓는다
    if (toastEl) document.body.append(toastEl);
    if (dialog.open) dialog.close();
    dialog.remove();
    const target = opener?.isConnected && opener !== document.body ? opener : document.getElementById("view");
    target?.focus?.({ preventScroll: true });
    resolver?.(value);
  };
  let resolver;
  const done = new Promise((resolve) => (resolver = resolve));
  dialog.append(build(close));
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    close(undefined);
  });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close, done };
}

/** 확인 대화상자. 확인하면 true. */
export function confirmDialog({ title, message, confirm = "확인", cancel = "취소", danger = false }) {
  const { done } = openDialog(title, (close) =>
    h("div", { class: "dlg" },
      h("h2", null, title),
      message ? h("p", { style: { margin: 0, color: "var(--text-2)" } }, message) : null,
      h("div", { class: "dlg-foot" },
        h("button", { class: "btn", on: { click: () => close(false) } }, cancel),
        h("button", { class: danger ? "btn stop" : "btn pri", on: { click: () => close(true) } }, confirm),
      ),
    ),
  );
  return done.then((v) => v === true);
}

// 날짜·시간 --------------------------------------------------------------------
export const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"];

export function parseDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function isoDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(iso, days) {
  const d = parseDate(iso);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

const weekdayOf = (d) => WEEKDAYS[(d.getDay() + 6) % 7];

export function fmtDate(iso) {
  const d = parseDate(iso);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${weekdayOf(d)}`;
}

export function fmtMonthDay(iso) {
  const d = parseDate(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function fmtWeekTitle(startIso, endIso) {
  const s = parseDate(startIso);
  const e = parseDate(endIso);
  const left = `${s.getMonth() + 1}월 ${s.getDate()}일`;
  const right = s.getMonth() === e.getMonth() ? `${e.getDate()}일` : `${e.getMonth() + 1}월 ${e.getDate()}일`;
  return `${left} – ${right}`;
}

export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r}초`;
  return r ? `${m}분 ${r}초` : `${m}분`;
}

export function fmtClock(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtIn(seconds) {
  if (seconds < 60) return "곧";
  const m = Math.floor(seconds / 60);
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  if (hh === 0) return `${mm}분 후`;
  return mm ? `${hh}시간 ${mm}분 후` : `${hh}시간 후`;
}

export function fmtDateTime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return { date: `${d.getMonth() + 1}월 ${d.getDate()}일 ${weekdayOf(d)}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

export function weekdaySummary(days) {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 7) return "매일";
  const isRun = sorted.length >= 3 && sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (isRun) return `${WEEKDAYS[sorted[0]]}~${WEEKDAYS[sorted.at(-1)]}`;
  return sorted.map((d) => WEEKDAYS[d]).join("·");
}

/** 단계 마디 막대. units: [{seconds}], index: 현재 단위(-1이면 진행 없음), ratio: 현재 단위 진행률 */
export function stepBar(units, { index = -1, ratio = 0, preview = false } = {}) {
  return h("div", { class: preview ? "seg preview" : "seg", "aria-hidden": "true" },
    units.map((u, i) => {
      const seg = h("i", { class: i < index ? "past" : "", style: { flex: String(Math.max(1, u.seconds || 1)) } });
      if (i === index) seg.append(h("b", { style: { width: `${Math.min(100, Math.max(0, ratio * 100))}%` } }));
      return seg;
    }),
  );
}
