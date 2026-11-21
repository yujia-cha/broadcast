// 설정 화면: 모든 항목에 기본값, 바꾸면 바로 저장
import { api, get, patch, post } from "../api.js";
import { confirmDialog, h, icon, toast, toastError } from "../ui.js";

const DEFAULTS = {
  autostart: true, close_to_tray: true, open_window_on_autostart: false,
  set_volume: true, volume: 70, pause_media: true, mute_others: true,
  default_voice: "", default_rate: 1.0, check_updates: true, theme: "system", auto_broadcast: true,
};

let ctx, root, settings;

export function mount(el, appCtx) {
  ctx = appCtx;
  root = el;
  el.replaceChildren(h("div", { class: "page" }, h("h2", null, "설정"), h("div", { class: "skel", style: { minHeight: "300px" } })));
  get("/api/settings").then((s) => {
    settings = s;
    if (root) render();
  }).catch((err) => {
    el.replaceChildren(h("div", { class: "page" }, h("h2", null, "설정"), h("div", { class: "card empty" }, h("h3", null, "설정을 불러오지 못했습니다"), h("p", null, err.message))));
  });
}

export function unmount() {
  root = null;
}

async function save(changes, savedEl) {
  try {
    settings = await patch("/api/settings", changes);
    if (savedEl) {
      savedEl.textContent = "저장됨";
      setTimeout(() => (savedEl.textContent = ""), 3000);
    }
    return true;
  } catch (err) {
    toastError(err);
    render();
    return false;
  }
}

function defaultNote(key, text) {
  const el = h("span");
  paintDefault(el, settings[key] !== DEFAULTS[key], text);
  return el;
}

function paintDefault(el, changed, text) {
  el.className = "def changed";
  el.textContent = changed ? `기본: ${text}` : "";
}

// 체크박스는 그 줄만 갱신한다(화면 전체를 다시 그리면 "저장됨" 표시와 포커스가 사라진다)
function checkRow(key, title, defText, desc = "") {
  const id = `set-${key}`;
  const saved = h("span", { class: "saved", "aria-live": "polite" });
  const def = defaultNote(key, defText);
  return h("div", { class: "srow" },
    h("input", { type: "checkbox", role: "switch", id, checked: settings[key], on: { change: async (e) => {
      if (await save({ [key]: e.target.checked }, saved)) paintDefault(def, settings[key] !== DEFAULTS[key], defText);
    } } }),
    h("label", { for: id }, h("span", null, title), desc ? h("span", { class: "d" }, desc) : null, saved),
    def,
  );
}

function render() {
  const s = settings;
  const volSaved = h("span", { class: "saved", "aria-live": "polite" });
  const volValue = h("span", { style: { minWidth: "40px" } }, `${s.volume}%`);
  const volDef = h("span");
  const paintVolumeDefault = () => paintDefault(volDef, settings.set_volume !== true || settings.volume !== 70, "켬 · 70%");
  paintVolumeDefault();
  const volSlider = h("input", {
    type: "range", min: 0, max: 100, step: 5, value: s.volume, disabled: !s.set_volume, "aria-label": "방송 음량",
    on: {
      input: (e) => (volValue.textContent = `${e.target.value}%`),
      change: async (e) => { if (await save({ volume: Number(e.target.value) }, volSaved)) paintVolumeDefault(); },
    },
  });
  const voices = ctx.voices || [];
  const rateSaved = h("span", { class: "saved", "aria-live": "polite" });
  const updateMsg = h("span", { class: "meta" });

  const page = h("div", { class: "page" },
    h("h2", null, "설정"),

    h("section", { class: "card sgrp", "aria-labelledby": "g-start" },
      h("h3", { id: "g-start" }, "시작과 창"),
      checkRow("autostart", "Windows에 로그인하면 자동 실행", "켬"),
      checkRow("close_to_tray", "창을 닫으면 트레이로 보내기", "켬"),
      checkRow("open_window_on_autostart", "자동 실행할 때 창 열기", "끔"),
    ),

    h("section", { class: "card sgrp", "aria-labelledby": "g-sound" },
      h("h3", { id: "g-sound" }, "방송 소리"),
      h("div", { class: "srow" },
        h("input", { type: "checkbox", id: "set-set_volume", checked: s.set_volume, on: { change: async (e) => {
          if (!(await save({ set_volume: e.target.checked }, volSaved))) return;
          volSlider.disabled = !settings.set_volume;
          paintVolumeDefault();
        } } }),
        h("div", { style: { display: "grid", gap: "var(--s2)" } },
          h("label", { for: "set-set_volume" }, h("span", null, "방송할 때 음량 맞추기")),
          h("div", { class: "range" },
            volSlider,
            volValue,
            h("button", { class: "btn sm", "aria-label": "이 음량으로 들어 보기", on: { click: () =>
              post("/api/preview", { kind: "tts", text: "방송 음량 시험입니다.", test_volume: Number(volSlider.value) })
                .then(() => toast("이 음량으로 들려줍니다.")).catch(toastError) } }, icon("play"), "들어 보기"),
            volSaved,
          ),
          h("span", { class: "d" }, "방송이 끝나면 원래 음량으로 돌아갑니다."),
        ),
        volDef,
      ),
      checkRow("pause_media", "방송 중 영상·음악 일시정지", "켬"),
      checkRow("mute_others", "방송 중 다른 앱 소리 끄기", "켬"),
    ),

    h("section", { class: "card sgrp", "aria-labelledby": "g-voice" },
      h("h3", { id: "g-voice" }, "음성(TTS)"),
      h("div", { class: "srow" },
        h("span"),
        h("div", { style: { display: "grid", gap: "var(--s3)" } },
          h("label", { class: "field" }, h("span", null, "기본 음성"),
            h("select", { class: "input", on: { change: (e) => save({ default_voice: e.target.value }, rateSaved) } },
              h("option", { value: "", selected: !s.default_voice }, "Windows 기본 음성"),
              voices.map((v) => h("option", { value: v.id, selected: v.id === s.default_voice }, `${v.name}${v.korean ? "" : " (한국어 아님)"}`)),
            )),
          h("div", { class: "field" }, h("span", { id: "rate-l" }, "기본 속도"), rateChips(s.default_rate, rateSaved)),
          h("div", { class: "step-row" },
            h("button", { class: "btn sm", on: { click: () => post("/api/preview", { kind: "tts", text: "안녕하세요. 정시 방송 음성 시험입니다.", voice: settings.default_voice, rate: settings.default_rate }).catch(toastError) } }, "미리듣기"),
            rateSaved,
          ),
        ),
        h("span"),
      ),
    ),

    h("section", { class: "card sgrp", "aria-labelledby": "g-look" },
      h("h3", { id: "g-look" }, "화면"),
      h("div", { class: "srow" },
        h("span"),
        h("div", { class: "field" },
          h("span", { id: "theme-label" }, "테마"),
          h("div", { class: "radios", role: "radiogroup", "aria-labelledby": "theme-label", style: { maxWidth: "320px" } },
            [["system", "시스템 설정"], ["light", "밝게"], ["dark", "어둡게"]].map(([v, label]) =>
              h("button", { role: "radio", "aria-checked": String(s.theme === v), on: { click: async () => {
                if (!(await save({ theme: v }))) return;
                if (v === "system") delete document.documentElement.dataset.theme;
                else document.documentElement.dataset.theme = v;
                render();
              } } }, label)),
          ),
        ),
        defaultNote("theme", "시스템 설정"),
      ),
    ),

    h("section", { class: "card sgrp", "aria-labelledby": "g-update" },
      h("h3", { id: "g-update" }, "업데이트"),
      checkRow("check_updates", "새 버전 자동 확인", "켬"),
      h("div", { class: "srow" },
        h("span"),
        h("div", { class: "step-row" },
          h("span", null, `현재 버전 v${ctx.status?.version ?? ""}`),
          h("button", { class: "btn sm", on: { click: async (e) => {
            e.target.disabled = true;
            updateMsg.textContent = "확인하는 중…";
            try {
              const res = await post("/api/update/check");
              updateMsg.textContent = res.release ? `새 버전 v${res.release.version}이 있습니다. 위쪽의 업데이트 버튼을 누르세요.` : "최신 버전입니다.";
            } catch (err) {
              updateMsg.textContent = err.message;
            }
            e.target.disabled = false;
          } } }, "지금 확인"),
          updateMsg,
        ),
        h("span"),
      ),
    ),

    h("section", { class: "card sgrp", "aria-labelledby": "g-data" },
      h("h3", { id: "g-data" }, "데이터"),
      h("div", { class: "srow" },
        h("span"),
        h("div", { style: { display: "grid", gap: "var(--s2)" } },
          h("div", { class: "step-row" },
            h("a", { class: "btn sm", href: "/api/export", download: "jeongsi-config.json" }, "설정 내보내기"),
            importButton(),
            h("button", { class: "btn sm", on: { click: () => post("/api/open-data-folder").catch(toastError) } }, "데이터 폴더 열기"),
          ),
        ),
        h("span"),
      ),
      h("div", { class: "srow" },
        h("span"),
        h("div", { class: "step-row" },
          h("button", { class: "btn sm", on: { click: resetDefaults } }, "모든 설정을 기본값으로"),
        ),
        h("span"),
      ),
    ),
  );
  root.replaceChildren(page);
}

function importButton() {
  const input = h("input", { type: "file", accept: ".json,application/json", hidden: true, on: { change: async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const ok = await confirmDialog({ title: "설정 가져오기", message: "지금의 방송 구성·시간표·설정을 파일 내용으로 바꿉니다.", confirm: "가져오기", danger: true });
      if (!ok) return;
      const res = await api("POST", "/api/import", data);
      await ctx.loadPrograms();
      settings = await get("/api/settings");
      render();
      const missing = res?.missing_files || [];
      if (missing.length) {
        // 소리 파일은 설정 파일에 들어 있지 않다: 이전 PC의 media 폴더를 옮겨야 그 방송이 나간다
        toast(`가져왔지만 소리 파일 ${missing.length}개가 없습니다. 이전 PC의 media 폴더를 데이터 폴더로 복사하세요.`, {
          error: true, action: { label: "데이터 폴더 열기", fn: () => post("/api/open-data-folder").catch(toastError) },
        });
      } else toast("설정을 가져왔습니다.");
    } catch (err) {
      toastError(err instanceof SyntaxError ? new Error("설정 파일 형식이 아닙니다.") : err);
    } finally {
      e.target.value = "";
    }
  } } });
  return [h("button", { class: "btn sm", on: { click: () => input.click() } }, "가져오기"), input];
}

async function resetDefaults() {
  const ok = await confirmDialog({ title: "설정을 기본값으로", message: "자동 실행, 방송 소리, 음성, 테마, 업데이트 설정을 처음 값으로 되돌립니다.", confirm: "되돌리기" });
  if (!ok) return;
  try {
    settings = await post("/api/settings/reset");
    render();
    toast("기본값으로 되돌렸습니다.");
  } catch (err) {
    toastError(err);
  }
}

// 속도: 방송 구성 화면과 같은 세 칩
const SPEEDS = [[0.8, "느리게"], [1.0, "보통"], [1.25, "빠르게"]];
function rateChips(value, savedEl) {
  const row = h("div", { class: "step-row", role: "radiogroup", "aria-labelledby": "rate-l" });
  const paint = (current) => row.replaceChildren(...SPEEDS.map(([r, label]) =>
    h("button", { class: "chip-btn", role: "radio", "aria-checked": String(current === r), "aria-pressed": String(current === r), on: { click: async () => {
      if (await save({ default_rate: r }, savedEl)) paint(r);
    } } }, label)));
  paint(value);
  return row;
}
