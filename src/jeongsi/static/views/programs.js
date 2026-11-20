// 방송 구성 화면: 왼쪽 목록, 오른쪽 단계 편집기
import { api, del, post, put } from "../api.js";
import { confirmDialog, fmtDuration, h, icon, openDialog, stepBar, toast, toastError } from "../ui.js";

const TTS_CHARS_PER_SECOND = 7;
const RATES = [0.5, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 2.0];

let ctx, root, listEl, editorEl;
const st = { selectedId: null, draft: null, original: "", errors: [], previewing: null };

export function mount(el, appCtx) {
  ctx = appCtx;
  root = el;
  listEl = h("nav", { class: "plist", "aria-label": "방송 구성 목록" });
  editorEl = h("section", { class: "editor", "aria-label": "방송 구성 편집" });
  el.replaceChildren(h("div", { class: "pg-page" }, listEl, editorEl));
  Promise.all([ctx.loadPrograms(), ctx.loadMedia()]).then(() => {
    if (!root) return;
    const keep = ctx.programs.find((p) => p.id === st.selectedId);
    if (keep) startEdit(keep);
    else startEdit(ctx.programs[0] || null);  // 구성이 없으면 새 구성 편집으로 시작
    render();
  }).catch(toastError);
}

export function unmount() {
  root = null;
}

export async function canLeave() {
  if (!isDirty()) return true;
  return confirmDialog({ title: "저장하지 않은 변경 사항이 있습니다", message: "지금 나가면 고친 내용이 사라집니다.", confirm: "버리고 나가기", cancel: "계속 편집", danger: true });
}

export function onStatus(status) {
  if (!root) return;
  const previewing = status.runner.state !== "idle" && status.runner.kind === "preview";
  if (!previewing && st.previewing) {
    st.previewing = null;
    renderEditor();
  }
}

function isDirty() {
  return st.draft && JSON.stringify(st.draft) !== st.original;
}

function startEdit(program) {
  st.selectedId = program?.id ?? null;
  st.draft = program
    ? { id: program.id, name: program.name, steps: program.steps.map((s) => ({ ...s })) }
    : { id: null, name: "", steps: [newStep("tts")] };
  st.original = JSON.stringify(st.draft);
  st.errors = [];
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
    h("button", { class: "btn", on: { click: () => switchTo(null) } }, icon("plus"), "새 방송 구성"),
    ...ctx.programs.map((p) =>
      h("button", { class: "plist-item", "aria-current": String(p.id === st.selectedId), on: { click: () => switchTo(p) } },
        h("b", null, p.name),
        h("span", null, p.summary),
        h("span", null, `약 ${fmtDuration(p.seconds)}${p.used_by.length ? ` · ${p.used_by.join(", ")}` : " · 쓰는 회차 없음"}`),
      ),
    ),
    h("button", { class: "btn ghost", on: { click: openMediaDialog } }, `올린 소리 파일 ${ctx.media.length}개 관리`),
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
  if (!st.draft) {
    editorEl.replaceChildren(
      h("div", { class: "card empty" },
        h("h3", null, "방송 구성이 없습니다"),
        h("p", null, "방송 구성은 차임, 음성 안내, 음악처럼 한 번에 내보낼 소리를 순서대로 쌓은 것입니다. 시간표의 회차가 이 구성을 정해진 시각에 내보냅니다."),
        h("button", { class: "btn pri", on: { click: () => switchTo(null) } }, icon("plus"), "새 방송 구성"),
      ),
    );
    return;
  }
  const d = st.draft;
  const nameInput = h("input", {
    class: "input", value: d.name, maxlength: 40, placeholder: "방송 구성 이름 (예: 점심 안내)", "aria-label": "방송 구성 이름",
    "aria-invalid": st.errors.includes("name") ? "true" : null,
    on: { input: (e) => { d.name = e.target.value; } },
  });
  const steps = h("div", { class: "steps" }, d.steps.map((step, i) => stepCard(step, i)));
  const addBar = h("div", { class: "step-row" },
    h("button", { class: "btn", on: { click: () => addStep("tts") } }, icon("plus"), "음성(TTS) 단계"),
    h("button", { class: "btn", on: { click: () => addStep("audio") } }, icon("plus"), "음악·소리 단계"),
  );
  const program = ctx.programs.find((p) => p.id === d.id);
  const units = expand(d);
  const total = units.reduce((a, u) => a + u.seconds, 0) + d.steps.reduce((a, s) => a + (s.repeat - 1) * s.gap_sec, 0);
  const errMsg = st.errorMessage ? h("p", { class: "err", role: "alert" }, st.errorMessage) : null;
  const previewingAll = st.previewing === "all";
  const foot = h("div", { class: "editor-foot" },
    h("span", { class: "meta" }, `${d.steps.length}단계 · 약 ${fmtDuration(total)}`),
    stepBar(units, { preview: true }),
    h("button", { class: "btn", on: { click: () => (previewingAll ? stopPreview() : previewAll()) } }, icon(previewingAll ? "stop" : "play"), previewingAll ? "정지" : "전체 미리듣기"),
    d.id ? h("button", { class: "btn danger", on: { click: () => removeProgram(program) } }, icon("trash"), "삭제") : null,
    h("button", { class: "btn pri", on: { click: save } }, "저장"),
  );
  const intro = !ctx.programs.length
    ? h("p", { class: "meta", style: { margin: 0 } }, "방송 구성은 차임, 음성 안내, 음악처럼 한 번에 내보낼 소리를 순서대로 쌓은 것입니다. 저장한 뒤 시간표에서 언제 내보낼지 정하세요.")
    : null;
  editorEl.replaceChildren(...[intro, h("div", { class: "editor-head" }, nameInput), steps, addBar, errMsg, foot].filter(Boolean));
}

function expand(d) {
  const units = [];
  for (const s of d.steps) for (let i = 0; i < s.repeat; i++) units.push({ seconds: estimate(s) });
  return units;
}

function estimate(step) {
  if (step.kind === "tts") return Math.max(1, (step.text || "").trim().length / (TTS_CHARS_PER_SECOND * (step.rate || 1)));
  return ctx.media.find((m) => m.name === step.file)?.seconds || 0;
}

function stepCard(step, i) {
  const d = st.draft;
  const id = `step-${step.id}`;
  const body = h("div", { class: "step-body" },
    h("div", { class: "step-row" },
      h("span", { class: "chip" }, step.kind === "tts" ? "음성(TTS)" : "음악·소리"),
      h("input", {
        class: "input", value: step.label, maxlength: 20, placeholder: step.kind === "tts" ? "단계 이름 (선택, 기본: 음성)" : "단계 이름 (선택, 예: 차임)",
        "aria-label": `${i + 1}단계 이름`, style: { flex: "1", minWidth: "160px" },
        on: { input: (e) => { step.label = e.target.value; } },
      }),
    ),
    step.kind === "tts" ? ttsFields(step, id) : audioFields(step, id),
    h("div", { class: "step-row" },
      h("span", { class: "lbl" }, "반복"),
      stepper(`${id}-rep`, step.repeat, 1, 20, (v) => { step.repeat = v; renderEditor(); }, "회"),
      step.repeat > 1 ? [h("span", { class: "lbl" }, "반복 사이"), stepper(`${id}-gap`, step.gap_sec, 0, 60, (v) => { step.gap_sec = v; }, "초")] : null,
    ),
  );
  const previewing = st.previewing === step.id;
  const tools = h("div", { class: "step-tools" },
    h("button", { class: "btn sm", on: { click: () => (previewing ? stopPreview() : preview(step)) } }, icon(previewing ? "stop" : "play"), previewing ? "정지" : "듣기"),
    h("div", { class: "row" },
      h("button", { class: "ibtn", "aria-label": `${i + 1}단계를 위로`, disabled: i === 0, on: { click: () => move(i, -1) } }, icon("up")),
      h("button", { class: "ibtn", "aria-label": `${i + 1}단계를 아래로`, disabled: i === d.steps.length - 1, on: { click: () => move(i, 1) } }, icon("down")),
      h("button", { class: "ibtn", "aria-label": `${i + 1}단계 복제`, disabled: d.steps.length >= 30, on: { click: () => duplicate(i) } }, icon("copy")),
      h("button", { class: "ibtn", "aria-label": `${i + 1}단계 삭제`, disabled: d.steps.length === 1, on: { click: () => { d.steps.splice(i, 1); renderEditor(); } } }, icon("trash")),
    ),
  );
  return h("div", { class: "step" }, h("span", { class: "ord" }, i + 1), body, tools);
}

function ttsFields(step, id) {
  const voices = ctx.voices || [];
  return [
    h("textarea", {
      class: "input", maxlength: 2000, rows: 3, placeholder: "읽어 줄 문구 (예: 점심시간입니다. 손을 씻고 급식실로 이동해 주세요.)",
      "aria-label": "읽어 줄 문구", value: step.text,
      on: { input: (e) => { step.text = e.target.value; } },
    }),
    h("div", { class: "step-row" },
      h("label", { class: "lbl", for: `${id}-voice` }, "음성"),
      h("select", { class: "input", id: `${id}-voice`, style: { maxWidth: "280px" }, on: { change: (e) => { step.voice = e.target.value; } } },
        h("option", { value: "", selected: !step.voice }, "기본 음성 (설정에서 고름)"),
        voices.map((v) => h("option", { value: v.id, selected: v.id === step.voice }, v.name)),
      ),
      h("label", { class: "lbl", for: `${id}-rate` }, "속도"),
      h("select", { class: "input", id: `${id}-rate`, on: { change: (e) => { step.rate = Number(e.target.value); } } },
        [...new Set([...RATES, step.rate])].sort((a, b) => a - b).map((r) => h("option", { value: r, selected: r === step.rate }, `${r}×`)),
      ),
    ),
  ];
}

function audioFields(step, id) {
  const fileInput = h("input", { type: "file", accept: ".mp3,.wav,.flac,.ogg,audio/*", hidden: true, on: { change: (e) => upload(e.target, step) } });
  const options = ctx.media.length
    ? ctx.media.map((m) => h("option", { value: m.name, selected: m.name === step.file }, `${m.display}${m.seconds ? ` · ${fmtDuration(m.seconds)}` : ""}`))
    : [h("option", { value: "" }, "올린 파일이 없습니다")];
  if (step.file && !ctx.media.some((m) => m.name === step.file)) options.unshift(h("option", { value: step.file, selected: true }, "(파일 없음) 다른 파일을 고르세요"));
  return h("div", { class: "step-row" },
    h("label", { class: "lbl", for: `${id}-file` }, "파일"),
    h("select", { class: "input", id: `${id}-file`, style: { flex: "1", minWidth: "200px" }, on: { change: (e) => { step.file = e.target.value; renderEditor(); } } }, options),
    h("button", { class: "btn sm", "data-upload": step.id, on: { click: () => fileInput.click() } }, icon("upload"), "파일 올리기"),
    fileInput,
  );
}

function stepper(id, value, min, max, onChange, unit) {
  const input = h("input", {
    id, type: "number", min, max, step: 1, value, inputmode: "numeric", "aria-label": unit === "회" ? "반복 횟수" : "반복 사이 간격(초)",
    on: { change: () => set(Number(input.value)) },
  });
  const set = (v) => {
    const clamped = Math.min(max, Math.max(min, Math.round(Number.isFinite(v) ? v : min)));
    input.value = clamped;
    onChange(clamped);
  };
  return h("span", { class: "stepper" },
    h("button", { type: "button", "aria-label": "줄이기", on: { click: () => set(Number(input.value) - 1) } }, "−"),
    input,
    h("button", { type: "button", "aria-label": "늘리기", on: { click: () => set(Number(input.value) + 1) } }, "+"),
    h("span", { class: "lbl", style: { padding: "0 8px 0 0" } }, unit),
  );
}

function addStep(kind) {
  st.draft.steps.push(newStep(kind));
  renderEditor();
  editorEl.querySelectorAll(".step").item(st.draft.steps.length - 1)?.querySelector("textarea, select")?.focus();
}

function duplicate(i) {
  const copy = { ...st.draft.steps[i], id: crypto.randomUUID().replaceAll("-", "").slice(0, 12) };
  st.draft.steps.splice(i + 1, 0, copy);
  renderEditor();
}

function move(i, delta) {
  const steps = st.draft.steps;
  [steps[i], steps[i + delta]] = [steps[i + delta], steps[i]];
  renderEditor();
}

async function upload(input, step) {
  const file = input.files?.[0];
  if (!file) return;
  const btn = editorEl.querySelector(`[data-upload="${step.id}"]`);
  if (btn) { btn.disabled = true; btn.textContent = "올리는 중…"; }
  const form = new FormData();
  form.append("file", file);
  try {
    const media = await api("POST", "/api/media", form);
    await ctx.loadMedia();
    step.file = media.name;
    if (!step.label) step.label = media.display.replace(/\.[^.]+$/, "").slice(0, 20);
    toast(`${media.display}을(를) 올렸습니다.`);
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
    await post("/api/broadcast/stop");
  } catch (err) {
    toastError(err);
  }
}

function validate(d) {
  st.errors = [];
  if (!d.name.trim()) {
    st.errors.push("name");
    return "이름을 입력하세요.";
  }
  for (const [i, s] of d.steps.entries()) {
    if (s.kind === "tts" && !s.text.trim()) return `${i + 1}단계: 읽어 줄 문구를 입력하세요.`;
    if (s.kind === "audio" && !s.file) return `${i + 1}단계: 재생할 파일을 고르거나 올리세요.`;
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
    startEdit(ctx.programs.find((p) => p.id === saved.id) || saved);
    st.errorMessage = "";
    render();
    toast("저장했습니다.");
  } catch (err) {
    st.errorMessage = err.message;
    renderEditor();
  }
}

async function removeProgram(program) {
  if (program?.used_by?.length) {
    st.errorMessage = `이 방송 구성을 쓰는 회차가 있어 지울 수 없습니다: ${program.used_by.join(", ")}`;
    return renderEditor();
  }
  const ok = await confirmDialog({ title: "방송 구성 삭제", message: `'${program.name}'을(를) 지웁니다. 되돌릴 수 없습니다.`, confirm: "지우기", danger: true });
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


// 소리 파일 관리 -----------------------------------------------------------------
function openMediaDialog() {
  let list, errEl;
  const usedBy = (name) => ctx.programs.filter((p) => p.steps.some((s) => s.kind === "audio" && s.file === name)).map((p) => p.name);
  const paint = () => {
    list.replaceChildren(
      ...(ctx.media.length
        ? ctx.media.map((m) => {
            const users = usedBy(m.name);
            return h("div", { class: "notice" },
              h("span", { style: { minWidth: 0, overflowWrap: "anywhere" } },
                m.display, h("span", { class: "hint" }, ` · ${m.seconds ? fmtDuration(m.seconds) : "길이 모름"} · ${users.length ? users.join(", ") : "쓰지 않음"}`)),
              h("button", {
                class: "link", disabled: users.length > 0, title: users.length ? "쓰는 방송 구성이 있어 지울 수 없습니다" : null,
                on: { click: async () => {
                  try {
                    await del(`/api/media/${encodeURIComponent(m.name)}`);
                    await ctx.loadMedia();
                    paint();
                    renderList();
                  } catch (err) {
                    errEl.textContent = err.message;
                  }
                } },
              }, "삭제"),
            );
          })
        : [h("p", { class: "hint" }, "올린 소리 파일이 없습니다. 음악·소리 단계에서 파일을 올리세요.")]),
    );
  };
  openDialog("올린 소리 파일", (close) =>
    h("div", { class: "dlg" },
      h("h2", null, "올린 소리 파일"),
      h("p", { class: "hint" }, "방송 구성에서 쓰지 않는 파일만 지울 수 있습니다."),
      (list = h("div", { style: { display: "grid", gap: "var(--s2)", maxHeight: "320px", overflow: "auto" } })),
      (errEl = h("p", { class: "err", role: "alert" })),
      h("div", { class: "dlg-foot" }, h("button", { class: "btn", on: { click: () => close() } }, "닫기")),
    ),
  );
  paint();
}
