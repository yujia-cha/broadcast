// 앱 뼈대: 화면 전환, 상태 폴링, 위쪽 바(방송 중 표시·업데이트·자동 방송), 안내 띠
import { get, patch, post } from "./api.js";
import { h, icon, openDialog, toast, toastError } from "./ui.js";
import * as timetable from "./views/timetable.js";
import * as programs from "./views/programs.js";
import * as historyView from "./views/history.js";
import * as settingsView from "./views/settings.js";

const VIEWS = { timetable, programs, history: historyView, settings: settingsView };
const POLL_MS = 1000;

export const ctx = {
  status: null,
  programs: [],
  media: [],
  voices: [],
  connected: true,
  async loadPrograms() {
    ctx.programs = await get("/api/programs");
    return ctx.programs;
  },
  async loadMedia() {
    ctx.media = await get("/api/media");
    return ctx.media;
  },
  go(view) {
    navigate(view);
  },
};

let current = null;
let currentName = null;

async function navigate(name) {
  if (!VIEWS[name]) name = "timetable";
  if (current?.canLeave && !(await current.canLeave())) return;
  current?.unmount?.();
  currentName = name;
  current = VIEWS[name];
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  for (const btn of document.querySelectorAll(".nav button")) {
    if (btn.dataset.view === name) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  }
  const view = document.getElementById("view");
  view.scrollTop = 0;
  current.mount(view, ctx);
}

// 상태 폴링 ---------------------------------------------------------------------
async function poll() {
  try {
    const status = await get("/api/status");
    const prev = ctx.status;
    ctx.status = status;
    ctx.connected = true;
    renderChrome(status);
    current?.onStatus?.(status, prev);
  } catch {
    ctx.connected = false;
    renderBanners(ctx.status);
  } finally {
    setTimeout(poll, POLL_MS);
  }
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
}

function renderChrome(status) {
  applyTheme(status.theme);
  const runner = status.runner;
  const onAir = runner.state !== "idle" && runner.kind !== "preview";
  const pill = document.getElementById("livepill");
  pill.hidden = !onAir;
  if (onAir) document.getElementById("livepill-text").textContent = `방송 중 · ${runner.name}`;

  const sw = document.getElementById("auto-switch");
  sw.setAttribute("aria-checked", String(status.auto_broadcast));

  const btn = document.getElementById("update-btn");
  const upd = status.update;
  const show = upd.release && ["available", "downloading", "ready", "error"].includes(upd.state);
  btn.hidden = !show;
  if (show) {
    btn.replaceChildren(icon("download"), upd.state === "downloading" ? "업데이트 받는 중" : `v${upd.release.version} 업데이트`);
  }
  renderBanners(status);
}

function renderBanners(status) {
  const el = document.getElementById("banners");
  const items = [];
  if (!ctx.connected) {
    items.push(h("div", { class: "banner error", role: "alert" }, icon("alert"), h("span", { class: "grow" }, "앱과 연결이 끊겼습니다. 다시 연결하는 중입니다.")));
  }
  if (status?.warning) items.push(h("div", { class: "banner warn" }, icon("alert"), h("span", { class: "grow" }, status.warning)));
  if (status && !status.auto_broadcast) {
    items.push(
      h("div", { class: "banner warn" }, icon("alert"),
        h("span", { class: "grow" }, "자동 방송이 꺼져 있어 예약한 방송이 나가지 않습니다."),
        h("button", { class: "link", on: { click: toggleAuto } }, "켜기"),
      ),
    );
  }
  if (status && !status.voices_ok) {
    items.push(
      h("div", { class: "banner" }, icon("alert"),
        h("span", { class: "grow" }, "한국어 음성이 설치되어 있지 않습니다. Windows 설정 › 시간 및 언어 › 음성에서 한국어 음성을 추가하세요."),
      ),
    );
  }
  el.replaceChildren(...items);
}

async function toggleAuto() {
  const next = !ctx.status?.auto_broadcast;
  try {
    await patch("/api/settings", { auto_broadcast: next });
    toast(next ? "자동 방송을 켰습니다." : "자동 방송을 껐습니다. 예약한 방송이 나가지 않습니다.");
  } catch (err) {
    toastError(err);
  }
}

// 업데이트 대화상자 ----------------------------------------------------------------
function openUpdateDialog() {
  const upd = ctx.status?.update;
  if (!upd?.release) return;
  const rel = upd.release;
  const published = rel.published_at ? new Date(rel.published_at).toLocaleDateString("ko-KR") : "";
  let bar, msg, applyBtn;
  const { close } = openDialog("새 버전", (close) =>
    h("div", { class: "dlg" },
      h("h2", null, `새 버전 v${rel.version}`),
      h("span", { class: "meta" }, `현재 v${upd.current}${published ? ` · ${published} 배포` : ""}`),
      rel.notes ? h("pre", { class: "notes" }, rel.notes) : null,
      h("div", { class: "progress", hidden: true }, (bar = h("i"))),
      (msg = h("p", { class: "hint" }, "업데이트하면 앱이 몇 초 동안 다시 시작됩니다. 방송 중에는 업데이트할 수 없습니다.")),
      h("div", { class: "dlg-foot" },
        h("a", { class: "link", href: rel.html_url, target: "_blank", rel: "noopener" }, "릴리즈 페이지"),
        h("span", { class: "grow" }),
        h("button", { class: "btn", on: { click: () => close() } }, "나중에"),
        (applyBtn = h("button", { class: "btn pri", on: { click: apply } }, "지금 업데이트")),
      ),
    ),
  );

  async function apply() {
    if (ctx.status.runner.state !== "idle" && ctx.status.runner.kind !== "preview") {
      msg.textContent = "방송 중에는 업데이트할 수 없습니다. 방송이 끝난 뒤 다시 시도하세요.";
      msg.className = "err";
      return;
    }
    applyBtn.disabled = true;
    applyBtn.textContent = "받는 중…";
    bar.parentElement.hidden = false;
    try {
      await post("/api/update/apply");
    } catch (err) {
      msg.textContent = err.message;
      msg.className = "err";
      applyBtn.disabled = false;
      applyBtn.textContent = "다시 시도";
      return;
    }
    const timer = setInterval(() => {
      const u = ctx.status?.update;
      if (!u) return;
      if (u.progress != null) bar.style.width = `${Math.round(u.progress * 100)}%`;
      if (u.state === "error") {
        clearInterval(timer);
        msg.textContent = u.message || "업데이트하지 못했습니다.";
        msg.className = "err";
        applyBtn.disabled = false;
        applyBtn.textContent = "다시 시도";
      } else if (u.state === "ready") {
        bar.style.width = "100%";
        msg.textContent = "새 버전으로 다시 시작합니다…";
      }
    }, 300);
  }
  return close;
}

// 시작 --------------------------------------------------------------------------
async function start() {
  for (const btn of document.querySelectorAll(".nav button")) {
    btn.addEventListener("click", () => navigate(btn.dataset.view));
  }
  document.getElementById("auto-switch").addEventListener("click", toggleAuto);
  document.getElementById("update-btn").addEventListener("click", openUpdateDialog);
  window.addEventListener("hashchange", () => {
    const name = location.hash.slice(1);
    if (name !== currentName) navigate(name);
  });
  try {
    ctx.status = await get("/api/status");
    renderChrome(ctx.status);
    await Promise.all([ctx.loadPrograms(), ctx.loadMedia(), get("/api/voices").then((v) => (ctx.voices = v))]);
  } catch (err) {
    toastError(err);
  }
  await navigate(location.hash.slice(1) || "timetable");
  setTimeout(poll, POLL_MS);
}

start();
