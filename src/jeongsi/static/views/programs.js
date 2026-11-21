// 방송 구성: 음성(말풍선)·음악(음표) 블록을 이어 붙인 띠를 직접 만진다.
// 블록을 끌어 순서를 바꾸고, 누르면 아래에서 그 블록을 고친다.
import { api, del, post, put } from "../api.js";
import { confirmDialog, fmtDuration, h, icon, openDialog, toast, toastError } from "../ui.js";
import { countPicker, iconAction, mediaPicker, strip } from "../visual.js";

const TTS_CHARS_PER_SECOND = 7;
const SPEEDS = [[0.8, "느리게"], [1.0, "보통"], [1.25, "빠르게"]];
const GAPS = [0, 1, 3, 5];

let ctx, root, listEl, editorEl;
const st = { selectedId: null, draft: null, original: "", sel: 0, errorMessage: "", previewing: null };

export function mount(el, appCtx) {
  ctx = appCtx;
  root = el;
  listEl = h("nav", { class: "plist", "aria-label": "방송 구성 목록" });
  editorEl = h("section", { class: "editor", "aria-label": "방송 구성 편집" });
  el.replaceChildren(h("div", { class: "pg-page" }, listEl, editorEl));
  if (ctx.selectProgramId) { st.selectedId = ctx.selectProgramId; ctx.selectProgramId = null; } // 방송 편집의 '내용 바꾸기'에서 옴
  Promise.all([ctx.loadPrograms(), ctx.loadMedia()]).then(() => {
    if (!root) return;
    startEdit(ctx.programs.find((p) => p.id === st.selectedId) || ctx.programs[0] || null);
    render();
  }).catch(toastError);
}

export function unmount() {
  root = null;
}

export async function canLeave() {
  if (!isDirty()) return true;
  return confirmDialog({ title: "저장하지 않았습니다", confirm: "버리기", cancel: "계속 고치기", danger: true });
}

export function onStatus(status) {
  if (!root) return;
  const previewing = status.runner.state !== "idle" && status.runner.kind === "preview";
  if (!previewing && st.previewing) {
    st.previewing = null;
    renderEditor();
  }
}

const isDirty = () => st.draft && JSON.stringify(st.draft) !== st.original;

function startEdit(program) {
  st.selectedId = program?.id ?? null;
  st.draft = program
    ? { id: program.id, name: program.name, steps: program.steps.map((s) => ({ ...s })) }
    : { id: null, name: "", steps: [newStep("tts")] };
  st.original = JSON.stringify(st.draft);
  st.sel = 0;
  st.errorMessage = "";
}

function newStep(kind) {
  return { id: crypto.randomUUID().replaceAll("-", "").slice(0, 12), kind, label: "", text: "", voice: "", rate: 1.0, file: kind === "audio" ? ctx.media[0]?.name ?? "" : "", repeat: 1, gap_sec: 0 };
}

function render() {
  renderList();
  renderEditor();
}

function renderList() {
  listEl.replaceChildren(
    h("button", { class: "btn ghost sm plist-media", on: { click: openMediaDialog } }, icon("music"), `음악 파일 ${ctx.media.length}`),
    ...ctx.programs.map((p) =>
      h("button", { class: "plist-item", "aria-current": String(p.id === st.selectedId), on: { click: () => switchTo(p) } },
        h("b", null, p.name),
        strip(p.steps, { size: "xs" }),
        h("span", null, `${fmtDuration(p.seconds)}${p.used_by.length ? ` · 예약 ${p.used_by.length}개` : " · 예약 없음"}`),
      )),
    h("button", { class: "plist-add", "aria-label": "새 방송 구성", on: { click: () => switchTo(null) } }, icon("plus")),
  );
}

async function switchTo(program) {
  if (program && program.id === st.selectedId) return;
  if (!(await canLeave())) return;
  startEdit(program);
  render();
  editorEl.querySelector("input")?.focus();
}

// 편집기 ------------------------------------------------------------------------
function renderEditor() {
  const d = st.draft;
  if (!d) return editorEl.replaceChildren();
  st.sel = Math.min(st.sel, d.steps.length - 1);
  const total = d.steps.reduce((a, s) => a + estimate(s) * s.repeat + s.gap_sec * (s.repeat - 1), 0);
  const program = ctx.programs.find((p) => p.id === d.id);
  editorEl.replaceChildren(...[
    h("input", {
      class: "input pg-name", value: d.name, maxlength: 40, placeholder: "이름 (예: 점심 안내)", "aria-label": "방송 구성 이름",
      on: { input: (e) => { d.name = e.target.value; } },
    }),
    blockTrack(d),
    stepPanel(d.steps[st.sel], st.sel),
    h("div", { class: "editor-foot" },
      // 오류는 아래 고정 바 안에 두어 가려지지 않게 한다
      st.errorMessage ? h("p", { class: "err foot-err", role: "alert" }, icon("alert"), st.errorMessage) : null,
      h("span", { class: "pg-total" }, icon("clock"), fmtDuration(total)),
      h("span", { class: "grow" }),
      iconAction(st.previewing === "all" ? "stop" : "play", st.previewing === "all" ? "정지" : "전체 듣기", () => (st.previewing === "all" ? stopPreview() : previewAll())),
      d.id ? iconAction("trash", "삭제", () => removeProgram(program), { tone: "danger" }) : null,
      h("button", { class: "btn pri", on: { click: save } }, icon("check"), "저장"),
    ),
  ].filter(Boolean));
}

// 블록 띠: 끌어서 순서 바꾸기, 눌러서 고르기 ----------------------------------------------------
function blockTrack(d) {
  const track = h("div", { class: "track", role: "listbox", "aria-label": "순서", "aria-orientation": "horizontal" });
  d.steps.forEach((step, i) => {
    const el = h("button", {
      class: `tblk blk-${step.kind}${i === st.sel ? " sel" : ""}`, role: "option", "aria-selected": String(i === st.sel), draggable: "true",
      "aria-label": `${i + 1}. ${step.kind === "tts" ? "음성" : "음악"} ${step.repeat}번`,
      on: {
        click: () => { st.sel = i; renderEditor(); },
        keydown: (e) => {
          if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
            e.preventDefault();
            move(i, e.key === "ArrowLeft" ? -1 : 1);
            editorEl.querySelector(".tblk.sel")?.focus();
          }
        },
        dragstart: (e) => { e.dataTransfer.setData("text/plain", String(i)); el.classList.add("dragging"); },
        dragend: () => el.classList.remove("dragging"),
        dragover: (e) => { e.preventDefault(); el.classList.add("over"); },
        dragleave: () => el.classList.remove("over"),
        drop: (e) => {
          e.preventDefault();
          const from = Number(e.dataTransfer.getData("text/plain"));
          if (Number.isInteger(from) && from !== i) {
            const [item] = d.steps.splice(from, 1);
            d.steps.splice(i, 0, item);
            st.sel = i;
            renderEditor();
          }
        },
      },
    },
      h("span", { class: "tblk-grip", "aria-hidden": "true" }, icon("grip")),
      h("span", { class: "tblk-i" }, icon(step.kind === "tts" ? "speech" : "music")),
      h("span", { class: "tblk-l" }, step.kind === "tts" ? (step.text.trim().slice(0, 12) || "음성") : (mediaName(step.file).replace(/\.[^.]+$/, "") || "음악")),
      step.repeat > 1 ? h("b", { class: "tblk-n" }, `×${step.repeat}`) : null,
    );
    track.append(el);
  });
  track.append(
    h("button", { class: "tblk-add blk-tts", "aria-label": "음성 추가", on: { click: () => addStep("tts") } }, icon("plus"), icon("speech")),
    h("button", { class: "tblk-add blk-audio", "aria-label": "음악 추가", on: { click: () => addStep("audio") } }, icon("plus"), icon("music")),
  );
  return track;
}

const mediaName = (name) => ctx.media.find((m) => m.name === name)?.display ?? "";

// 고른 블록 고치기 ----------------------------------------------------------------
function stepPanel(step, i) {
  const d = st.draft;
  const body = step.kind === "tts" ? ttsBody(step) : audioBody(step);
  return h("div", { class: `step-panel edge-${step.kind}` },
    body,
    h("div", { class: "sp-row" },
      h("span", { class: "sp-label", id: `cnt-${step.id}` }, step.kind === "tts" ? "몇 번 읽기" : "몇 번 틀기"),
      countPicker(step.kind, step.repeat > 5 ? null : step.repeat, (n) => { step.repeat = n; renderEditor(); }),
      step.repeat > 1 ? h("div", { class: "gap-pick", role: "radiogroup", "aria-label": "반복 사이 쉬는 시간" },
        icon("clock"),
        GAPS.map((g) => h("button", { class: "chip-btn", role: "radio", "aria-pressed": String(step.gap_sec === g), on: { click: () => { step.gap_sec = g; renderEditor(); } } }, g ? `${g}초` : "바로"))) : null,
    ),
    h("div", { class: "ia-row" },
      iconAction(st.previewing === step.id ? "stop" : "play", st.previewing === step.id ? "정지" : "듣기", () => (st.previewing === step.id ? stopPreview() : preview(step))),
      iconAction("copy", "복제", () => duplicate(i), { disabled: d.steps.length >= 30 }),
      iconAction("x", "빼기", () => { d.steps.splice(i, 1); st.sel = Math.max(0, i - 1); renderEditor(); }, { disabled: d.steps.length === 1 }),
    ),
  );
}

function ttsBody(step) {
  const voices = ctx.voices || [];
  return h("div", { class: "wz-stack" },
    h("textarea", {
      class: "input wz-input", rows: 3, maxlength: 2000, placeholder: "읽어 줄 문구", "aria-label": "읽어 줄 문구", value: step.text,
      on: { input: (e) => { step.text = e.target.value; }, change: () => renderEditor() },
    }),
    h("div", { class: "sp-row" },
      h("div", { class: "seg-pick", role: "radiogroup", "aria-label": "빠르기" },
        SPEEDS.map(([r, label]) => h("button", { class: "chip-btn", role: "radio", "aria-pressed": String(step.rate === r), on: { click: () => { step.rate = r; renderEditor(); } } }, label))),
      voices.length > 1 ? h("select", { class: "input", "aria-label": "음성", style: { maxWidth: "240px" }, on: { change: (e) => { step.voice = e.target.value; } } },
        h("option", { value: "", selected: !step.voice }, "기본 음성"),
        voices.map((v) => h("option", { value: v.id, selected: v.id === step.voice }, v.name))) : null,
    ),
  );
}

function audioBody(step) {
  const input = h("input", { type: "file", accept: ".mp3,.wav,.flac,.ogg,audio/*", hidden: true, on: { change: () => upload(input, step) } });
  return mediaPicker({
    media: ctx.media, selected: step.file, collapse: true,
    upload: h("div", null, h("button", { class: "wz-file wz-upload", "data-upload": step.id, on: { click: () => input.click() } }, h("span", { class: "wz-file-i" }, icon("upload")), h("span", null, "파일 올리기")), input),
    onPick: (m) => { step.file = m.name; step.label = m.display.replace(/\.[^.]+$/, "").slice(0, 20); renderEditor(); },
    onPreview: (m) => post("/api/preview", { kind: "audio", file: m.name }).then(() => toast(`${m.display} 듣는 중…`)).catch(toastError),
  });
}

function estimate(step) {
  if (step.kind === "tts") return Math.max(1, (step.text || "").trim().length / (TTS_CHARS_PER_SECOND * (step.rate || 1)));
  return ctx.media.find((m) => m.name === step.file)?.seconds || 0;
}

function addStep(kind) {
  st.draft.steps.push(newStep(kind));
  st.sel = st.draft.steps.length - 1;
  renderEditor();
  editorEl.querySelector(".step-panel textarea, .step-panel .wz-file")?.focus();
}

function duplicate(i) {
  st.draft.steps.splice(i + 1, 0, { ...st.draft.steps[i], id: crypto.randomUUID().replaceAll("-", "").slice(0, 12) });
  st.sel = i + 1;
  renderEditor();
}

function move(i, delta) {
  const steps = st.draft.steps;
  const j = i + delta;
  if (j < 0 || j >= steps.length) return;
  [steps[i], steps[j]] = [steps[j], steps[i]];
  st.sel = j;
  renderEditor();
}

async function upload(input, step) {
  const file = input.files?.[0];
  if (!file) return;
  const btn = editorEl.querySelector(`[data-upload="${step.id}"]`);
  if (btn) { btn.disabled = true; btn.lastChild.textContent = "올리는 중…"; }
  const form = new FormData();
  form.append("file", file);
  try {
    const media = await api("POST", "/api/media", form);
    await ctx.loadMedia();
    step.file = media.name;
    step.label = media.display.replace(/\.[^.]+$/, "").slice(0, 20);
    renderList();
    toast(`${media.display}로 바꿨습니다.`);
  } catch (err) {
    toastError(err);
  }
  renderEditor();
}

async function preview(step) {
  try {
    await post("/api/preview", { ...step, repeat: 1, gap_sec: 0 });
    st.previewing = step.id;
    renderEditor();
  } catch (err) {
    toastError(err);
  }
}

async function previewAll() {
  const d = st.draft;
  const problem = validate({ ...d, name: d.name || "미리듣기" });
  if (problem) {
    st.errorMessage = problem;
    return renderEditor();
  }
  try {
    await post("/api/preview", { name: d.name || "미리듣기", steps: d.steps });
    st.previewing = "all";
    st.errorMessage = "";
    renderEditor();
  } catch (err) {
    toastError(err);
  }
}

async function stopPreview() {
  try {
    await post("/api/broadcast/stop", { kind: "preview" });
  } catch (err) {
    toastError(err);
  }
}

function validate(d) {
  if (!d.name.trim()) return "이름을 입력하세요.";
  for (const [i, s] of d.steps.entries()) {
    if (s.kind === "tts" && !s.text.trim()) { st.sel = i; return "읽어 줄 문구를 입력하세요."; }
    if (s.kind === "audio" && !s.file) { st.sel = i; return "음악 파일을 고르세요."; }
  }
  return "";
}

async function save() {
  const d = st.draft;
  st.errorMessage = validate(d);
  if (st.errorMessage) return renderEditor();
  const body = { name: d.name.trim(), steps: d.steps };
  try {
    const saved = d.id ? await put(`/api/programs/${d.id}`, body) : await post("/api/programs", body);
    await ctx.loadPrograms();
    const sel = st.sel;
    startEdit(ctx.programs.find((p) => p.id === saved.id) || saved);
    st.sel = sel;
    render();
    toast("저장했습니다.");
  } catch (err) {
    st.errorMessage = err.message;
    renderEditor();
  }
}

async function removeProgram(program) {
  if (program?.used_by?.length) {
    st.errorMessage = `예약된 방송(${program.used_by.join(", ")})이 이 구성을 써서 지울 수 없어요. 시간표에서 그 방송을 먼저 지우세요.`;
    return renderEditor();
  }
  const ok = await confirmDialog({ title: `'${program.name}' 지우기`, confirm: "지우기", danger: true });
  if (!ok) return;
  try {
    await del(`/api/programs/${program.id}`);
    await ctx.loadPrograms();
    startEdit(ctx.programs[0] || null);
    render();
    toast("지웠습니다.");
  } catch (err) {
    st.errorMessage = err.message;
    renderEditor();
  }
}

// 음악 파일 관리: 듣기·올리기·지우기(쓰는 파일은 '사용 중' 표시, 지우기 전 확인) --------------------------------
function openMediaDialog() {
  let list, errEl, uploadBtn;
  const usedBy = (name) => ctx.programs.filter((p) => p.steps.some((s) => s.kind === "audio" && s.file === name)).map((p) => p.name);
  const input = h("input", { type: "file", accept: ".mp3,.wav,.flac,.ogg,audio/*", hidden: true, on: { change: async () => {
    const file = input.files?.[0];
    if (!file) return;
    uploadBtn.disabled = true;
    const form = new FormData();
    form.append("file", file);
    try {
      const m = await api("POST", "/api/media", form);
      await ctx.loadMedia();
      paint();
      renderList();
      toast(`${m.display}을(를) 올렸습니다.`);
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      uploadBtn.disabled = false;
      input.value = "";
    }
  } } });
  const remove = async (m) => {
    if (!(await confirmDialog({ title: `'${m.display}' 지우기`, confirm: "지우기", danger: true }))) return;
    try {
      await del(`/api/media/${encodeURIComponent(m.name)}`);
      await ctx.loadMedia();
      paint();
      renderList();
      toast("지웠습니다.");
    } catch (err) {
      errEl.textContent = err.message;
    }
  };
  const paint = () => {
    errEl.textContent = "";
    list.replaceChildren(
      ...(ctx.media.length
        ? ctx.media.map((m) => {
            const users = usedBy(m.name);
            return h("div", { class: "wz-file media-row" },
              h("button", { class: "ibtn wz-file-play", "aria-label": `${m.display} 듣기`, on: { click: () => post("/api/preview", { kind: "audio", file: m.name }).then(() => toast(`${m.display} 듣는 중…`)).catch(toastError) } }, icon("play")),
              h("span", { class: "wz-file-n" }, m.display),
              h("small", null, m.seconds ? fmtDuration(m.seconds) : ""),
              users.length
                ? h("span", { class: "in-use", title: users.join(", ") }, "사용 중")
                : h("button", { class: "ibtn", "aria-label": `${m.display} 지우기`, on: { click: () => remove(m) } }, icon("trash")),
            );
          })
        : [h("p", { class: "hint" }, "올린 파일이 없습니다.")]),
    );
  };
  openDialog("음악 파일", (close) =>
    h("div", { class: "dlg" },
      h("h2", null, "음악 파일"),
      (uploadBtn = h("button", { class: "wz-file wz-upload", on: { click: () => input.click() } }, h("span", { class: "wz-file-i" }, icon("upload")), h("span", null, "파일 올리기"))),
      input,
      (list = h("div", { style: { display: "grid", gap: "var(--s2)", maxHeight: "360px", overflow: "auto" } })),
      (errEl = h("p", { class: "err", role: "alert" })),
      h("div", { class: "dlg-foot" }, h("button", { class: "btn", on: { click: () => close() } }, "닫기")),
    ),
  );
  paint();
}
