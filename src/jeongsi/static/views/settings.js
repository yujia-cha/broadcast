// 설정 화면: 모든 항목에 기본값, 바꾸면 바로 저장
import { api, get, patch, post } from "../api.js";
import { confirmDialog, h, toast, toastError } from "../ui.js";

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
      setTimeout(() => (savedEl.textContent = ""), 1800);
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
  el.className = `def${changed ? " changed" : ""}`;
  el.textContent = changed ? `기본: ${text}` : "기본값";
}

// 체크박스는 그 줄만 갱신한다(화면 전체를 다시 그리면 "저장됨" 표시와 포커스가 사라진다)
function checkRow(key, title, desc, defText) {
  const id = `set-${key}`;
  const saved = h("span", { class: "saved", "aria-live": "polite" });
  const def = defaultNote(key, defText);
  return h("div", { class: "srow" },
    h("input", { type: "checkbox", id, checked: settings[key], on: { change: async (e) => {
      if (await save({ [key]: e.target.checked }, saved)) paintDefault(def, settings[key] !== DEFAULTS[key], defText);
    } } }),
    h("label", { for: id }, h("span", null, title), h("span", { class: "d" }, desc), saved),
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
    h("p", { class: "hint" }, "바꾸면 바로 저장됩니다. 처음 값 그대로 써도 됩니다."),

    h("section", { class: "card sgrp", "aria-labelledby": "g-start" },
      h("h3", { id: "g-start" }, "시작과 창"),
      checkRow("autostart", "Windows에 로그인하면 자동 실행", "끄면 직접 실행하기 전까지 예약 방송이 나가지 않습니다.", "켬"),
      checkRow("close_to_tray", "창을 닫으면 트레이로 보내기", "끄면 창을 닫을 때 앱이 종료되어 예약 방송이 나가지 않습니다.", "켬"),
      checkRow("open_window_on_autostart", "자동 실행할 때 창 열기", "끄면 트레이 아이콘으로만 조용히 시작합니다.", "끔"),
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
            volValue, volSaved,
          ),
          h("span", { class: "d" }, "PC가 음소거여도 방송 동안만 풀고, 끝나면 원래 음량·음소거로 되돌립니다."),
        ),
        volDef,
      ),
      checkRow("pause_media", "재생 중인 영상·음악 일시정지", "YouTube, Spotify처럼 일시정지를 지원하는 앱. 방송이 끝나면 다시 재생합니다.", "켬"),
      checkRow("mute_others", "다른 앱 소리 음소거", "일시정지를 지원하지 않는 앱과 알림음까지 방송 동안 음소거합니다.", "켬"),
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
          h("label", { class: "field" }, h("span", null, "기본 속도"),
            h("select", { class: "input", style: { maxWidth: "160px" }, on: { change: (e) => save({ default_rate: Number(e.target.value) }, rateSaved) } },
              [0.75, 0.9, 1.0, 1.1, 1.25, 1.5].map((r) => h("option", { value: r, selected: r === s.default_rate }, `${r}×`)))),
          h("div", { class: "step-row" },
            h("button", { class: "btn sm", on: { click: () => post("/api/preview", { kind: "tts", text: "안녕하세요. 정시 방송 음성 시험입니다.", voice: settings.default_voice, rate: settings.default_rate }).catch(toastError) } }, "미리듣기"),
            rateSaved,
          ),
          h("span", { class: "d" }, "단계에서 음성을 따로 고르지 않으면 이 음성을 씁니다."),
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
      checkRow("check_updates", "새 버전 자동 확인", "앱을 켤 때와 하루 한 번 확인합니다. 설치는 업데이트 버튼을 눌렀을 때만 합니다.", "켬"),
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
          h("span", { class: "d" }, "내보낸 파일에는 방송 구성·시간표·설정이 들어 있습니다. 소리 파일은 데이터 폴더의 media에 있습니다."),
        ),
        h("span"),
      ),
      h("div", { class: "srow" },
        h("span"),
        h("div", { class: "step-row" },
          h("button", { class: "btn sm", on: { click: resetDefaults } }, "모든 설정을 기본값으로"),
          h("span", { class: "d" }, "방송 구성과 시간표는 그대로 둡니다."),
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
      await api("POST", "/api/import", data);
      await ctx.loadPrograms();
      settings = await get("/api/settings");
      render();
      toast("설정을 가져왔습니다.");
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
