// 기록 화면: 실제로 방송한 것만(완료·정지·실패)
import { get } from "../api.js";
import { fmtDateTime, fmtDuration, h } from "../ui.js";

const RESULT = { done: ["완료", "ok"], stopped: ["정지", ""], failed: ["실패", "bad"] };
let root;

export function mount(el) {
  root = el;
  const page = h("div", { class: "page" }, h("h2", null, "기록"), h("div", { class: "skel", style: { minHeight: "200px" } }));
  el.replaceChildren(page);
  load(page);
}

export function unmount() {
  root = null;
}

async function load(page) {
  let items;
  try {
    items = await get("/api/history?limit=300");
  } catch (err) {
    page.replaceChildren(h("h2", null, "기록"), h("div", { class: "card empty" }, h("h3", null, "기록을 불러오지 못했습니다"), h("p", null, err.message)));
    return;
  }
  if (!root) return;
  if (!items.length) {
    page.replaceChildren(h("h2", null, "기록"),
      h("div", { class: "card empty" }, h("h3", null, "아직 방송 기록이 없습니다"), h("p", null, "예약 방송이나 '지금 방송'으로 내보낸 방송이 여기에 쌓입니다.")));
    return;
  }
  page.replaceChildren(
    h("h2", null, "기록"),
    h("p", { class: "hint" }, "실제로 방송한 것만 남습니다. 최근 300개까지 보여 줍니다."),
    h("div", { class: "table-wrap" },
      h("table", null,
        h("thead", null, h("tr", null, ["날짜", "시각", "이름", "종류", "결과", "길이"].map((t) => h("th", { scope: "col" }, t)))),
        h("tbody", null,
          items.map((e) => {
            const start = fmtDateTime(e.started_at);
            const [label, cls] = RESULT[e.result] || [e.result, ""];
            const seconds = (new Date(e.ended_at) - new Date(e.started_at)) / 1000;
            return h("tr", null,
              h("td", null, start.date),
              h("td", null, start.time),
              h("td", null, e.name, e.error ? h("div", { class: "hint" }, e.error) : null),
              h("td", null, e.kind === "scheduled" ? "예약" : "직접"),
              h("td", null, h("span", { class: `chip ${cls}` }, label)),
              h("td", null, fmtDuration(seconds)),
            );
          }),
        ),
      ),
    ),
  );
}
