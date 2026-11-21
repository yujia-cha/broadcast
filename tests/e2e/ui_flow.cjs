// 화면 E2E: 실제 서버(가짜 오디오)에 브라우저로 접속해 그림 중심 화면을 직접 만져 본다.
// 사용: node tests/e2e/ui_flow.cjs <기본 주소> <스크린샷 폴더> <소리 파일 폴더>
const { chromium } = require("playwright");
const path = require("path");

const [base, outDir, assetDir] = process.argv.slice(2);
const steps = [];

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  if (process.env.E2E_DEBUG) page.on("response", (r) => r.request().method() !== "GET" && console.log("  ", r.request().method(), r.url().replace(base, "/"), r.status()));
  const shot = async (name) => {
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  };
  const step = async (name, fn) => {
    process.stdout.write(`- ${name} ... `);
    await fn();
    steps.push(name);
    console.log("ok");
  };
  const toast = (text) => page.waitForSelector(`#toast.show >> text=${text}`);
  // 시간표는 매분 다시 그려진다: 그 순간에 걸린 동작은 한 번 더 시도한다
  const retry = async (fn, times = 3) => {
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (err) {
        if (i >= times - 1 || !/not attached|detached/i.test(String(err))) throw err;
        await page.waitForTimeout(400);
      }
    }
  };

  try {
    await step("첫 화면: 빈 달력과 새 방송 버튼", async () => {
      await page.goto(base);
      await page.waitForSelector(".cal-empty");
      await shot("01-empty");
    });

    await step("새 방송: 그림을 눌러 차례로 답하기", async () => {
      await page.click(".cal-empty");
      await page.fill(".wz-active input", "점심 안내");
      await page.keyboard.press("Enter");
      await page.click(".wz-tile >> text=음성 + 음악");
      await page.fill(".wz-active textarea", "점심시간입니다.");
      await page.click("#wz-next");
      await page.click('.cp-item[aria-label="2번"]');
      const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click(".wz-upload")]);
      await chooser.setFiles(path.join(assetDir, "chime.wav"));
      await page.click('.cp-item[aria-label="1번"]');
      await page.waitForSelector(".tp-time");
      // −1시간 버튼을 키보드로 이어 누를 수 있어야 한다(누른 뒤에도 초점이 버튼에 남음)
      const before = await page.inputValue(".tp-time");
      await page.focus('button[aria-label="1시간 일찍"]');
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      const two = Math.max(0, Number(before.slice(0, 2)) - 2);
      if (Number((await page.inputValue(".tp-time")).slice(0, 2)) !== two) throw new Error(`−1시간을 두 번 눌렀는데 ${await page.inputValue(".tp-time")}`);
      await page.focus(".tp-pin");
      await page.keyboard.press("End");
      if ((await page.inputValue(".tp-time")) !== "23:55") throw new Error(`시각이 다릅니다: ${await page.inputValue(".tp-time")}`);
      await shot("02-wizard-time");
      await page.keyboard.press("Enter");
      await page.click(".wz-tile >> text=매주");
      await page.click(".chip-btn >> text=매일");
      await page.waitForSelector(".ticket");
      await shot("03-wizard-ticket");
    });

    await step("티켓에서 이름 고치기 → 다시 확인", async () => {
      await page.click('.tk-row[aria-label="방송 이름 고치기"]');
      await page.fill(".wz-active input", "점심 방송");
      await page.click("#wz-next");
      await page.waitForSelector(".ticket >> text=점심 방송");
    });

    await step("확인 없이 만들기 → 확인 칸 안내, 체크 후 만들기 → 시간표에 블록", async () => {
      await page.click(".wz-cta >> text=만들기");
      await page.waitForSelector(".wz-agree.nudge");
      if (!(await page.isVisible("#wz-q >> text=이대로 만들까요?"))) throw new Error("확인 전인데 만들어졌습니다");
      await page.check("#wz-agree");
      await page.click(".wz-cta >> text=만들기");
      await page.waitForSelector("#wz-q >> text=예약했어요");
      await page.click("text=시간표 보기");
      await page.waitForSelector('.cblock[aria-label*="점심 방송"]');
      await shot("04-calendar");
    });

    await step("새 방송: 특정 날짜 여러 개 고르기", async () => {
      await page.click("#new-btn");
      await page.fill(".wz-active input", "행사 안내");
      await page.keyboard.press("Enter");
      await page.click(".wz-tile >> text=음성");
      await page.fill(".wz-active textarea", "행사가 곧 시작합니다.");
      await page.click("#wz-next");
      await page.click('.cp-item[aria-label="1번"]');
      await page.keyboard.press("Enter");
      await page.click(".wz-tile >> text=특정 날짜");
      const days = page.locator(".wz-active .rc-day:not([disabled])");
      await days.nth(1).click();
      await days.nth(3).click();
      if ((await page.locator(".date-chip").count()) !== 2) throw new Error("고른 날짜가 2개가 아닙니다");
      await shot("03b-wizard-dates");
      await page.click("#wz-next");
      await page.waitForSelector(".ticket .dchips");
      await page.check("#wz-agree");
      await page.click(".wz-cta >> text=만들기");
      await page.waitForSelector("#wz-q >> text=예약했어요");
      await page.click("text=시간표 보기");
      await page.waitForSelector('.cblock[aria-label*="점심 방송"]');
    });

    await step("블록을 끌어 오늘만 시각 바꾸기", async () => {
      const blk = page.locator(".cal-col.today .cblock.next");
      await retry(() => blk.scrollIntoViewIfNeeded());
      const box = await blk.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      // 한 시간 = 시간 눈금 간격만큼 위로
      const hourPx = await page.evaluate(() => {
        const labels = [...document.querySelectorAll(".cal-axis span")];
        return labels[2].getBoundingClientRect().top - labels[1].getBoundingClientRect().top;
      });
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - hourPx / 2, { steps: 4 });
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - hourPx, { steps: 4 });
      await page.mouse.up();
      await page.waitForSelector(".cal-col.today .cblock.chg >> text=22:55");
      await page.waitForSelector("#toast.show .toast-act >> text=되돌리기");
      await page.waitForFunction(() => !document.querySelector("#toast.show"), null, { timeout: 10000 });
    });

    await step("살짝 흔들린 클릭은 시각을 바꾸지 않음", async () => {
      const blk = page.locator(".cal-col.today .cblock.chg");
      await retry(() => blk.scrollIntoViewIfNeeded());
      const box = await blk.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 6, { steps: 3 });
      await page.mouse.up();
      await page.waitForSelector(".pop .ia >> text=원래대로");
      await page.keyboard.press("Escape");
      await page.waitForSelector(".cal-col.today .cblock.chg >> text=22:55");
    });

    await step("블록 누르기 → 원래대로", async () => {
      await page.click(".cal-col.today .cblock.chg");
      await page.click(".pop .ia >> text=원래대로");
      await page.waitForSelector(".cal-col.today .cblock.next >> text=23:55");
    });

    await step("블록 누르기 → 이번만 끄기 → 되살리기", async () => {
      await page.click(".cal-col.today .cblock.next");
      await shot("05-popover");
      await page.click(".pop .ia >> text=이번만 끄기");
      await page.waitForSelector(".cal-col.today .cblock.off");
      await page.click(".cal-col.today .cblock.off");
      await page.click(".pop .ia >> text=되살리기");
      await page.waitForSelector(".cal-col.today .cblock.next");
    });

    await step("이번만 끄기 → 되돌리기", async () => {
      await page.click(".rail .ia >> text=이번만 끄기");
      await page.waitForSelector(".undo-chip");
      await page.click(".undo-chip");
      await toast("되돌렸습니다.");
    });

    await step("요일 머리 → 이 날 쉬기 → 해제", async () => {
      await page.locator(".cal-day").first().click();
      await page.click(".pop .ia >> text=이 날 쉬기");
      await page.waitForSelector(".cal-day.off");
      await page.locator(".cal-day.off").first().click();
      await page.click(".pop .ia >> text=쉬기 해제");
      await page.waitForSelector(".cal-day.off", { state: "detached" });
    });

    await step("쉬는 날: 달력에서 기간 골라 추가 → 삭제", async () => {
      await page.click(".weekbar button:has-text(\"쉬는 날\")");
      if (!(await page.locator("dialog >> button:has-text('추가')").isDisabled())) throw new Error("날을 고르기 전인데 추가가 눌립니다");
      await page.click('dialog button[aria-label="다음 달"]');
      const days = page.locator("dialog .rc-day:not([disabled])");
      await days.nth(10).click();
      await days.nth(12).click();
      await page.fill('dialog input[aria-label="메모"]', "겨울 방학");
      await page.click("dialog >> button:has-text('추가')");
      await page.waitForSelector("dialog .off-chip >> text=겨울 방학");
      await page.waitForSelector("dialog .rc-day.marked");
      await page.click('dialog .off-x[aria-label$="삭제"]');
      await page.waitForSelector("#toast.show .toast-act >> text=되돌리기");
      await page.waitForSelector("dialog .off-chip", { state: "detached" });
      await page.click("dialog >> text=닫기");
    });

    await step("매주 일정 편집 열고 저장", async () => {
      await page.click(".cal-col.today .cblock.next");
      await page.click(".pop .ia >> text=편집");
      await page.waitForSelector("dialog .wdp");
      // 기간: 시작이 있으면 다음 누름은 끝날
      await page.click("dialog .period .chip-btn");
      await page.locator("dialog .rc-day:not([disabled])").nth(3).click();
      await page.waitForSelector("dialog .period .chip-btn >> text=까지");
      await page.click("dialog .period >> text=기간 없애기");
      // 특정 날짜 달력은 이번 달부터
      await page.click("dialog .mode-seg >> text=특정 날짜");
      const month = await page.evaluate(() => new Date().getMonth() + 1);
      await page.waitForSelector(`dialog .rc-head b >> text=${month}월`);
      await page.click("dialog .mode-seg >> text=매주");
      await page.click("dialog >> button:has-text('저장')");
      await toast("저장했습니다.");
    });

    await step("방송 구성: 블록 띠 복제·빼기·저장", async () => {
      await page.click(".nav >> text=방송 구성");
      await page.waitForSelector(".track");
      if ((await page.locator(".tblk").count()) !== 2) throw new Error("블록 수가 다릅니다");
      await page.locator(".tblk").nth(1).click();
      await page.click(".step-panel .ia >> text=복제");
      if ((await page.locator(".tblk").count()) !== 3) throw new Error("복제가 되지 않았습니다");
      await page.click(".step-panel .ia >> text=빼기");
      // 문구를 고친 직후 '저장'을 한 번만 눌러도 저장돼야 한다(첫 클릭이 무시되던 문제)
      await page.locator(".tblk").first().click();
      await page.fill(".step-panel textarea", "점심시간입니다. 식당으로 오세요.");
      await page.click(".editor-foot >> text=저장");
      await toast("저장했습니다.");
      await shot("06-program");
    });

    await step("전체 듣기 → 정지", async () => {
      await page.click(".editor-foot .ia >> text=전체 듣기");
      await page.waitForSelector(".editor-foot .ia >> text=정지");
      await page.click(".editor-foot .ia >> text=정지");
      await page.waitForSelector(".editor-foot .ia >> text=전체 듣기");
    });

    await step("음악 파일: 쓰는 파일은 지울 수 없음", async () => {
      await page.click(".plist >> text=음악 파일 1");
      await page.waitForSelector("dialog .in-use >> text=사용 중");
      if (await page.locator('dialog button[aria-label$="지우기"]').count()) throw new Error("쓰는 파일인데 지울 수 있습니다");
      await page.click("dialog >> text=닫기");
    });

    await step("지금 방송 → 넘기기 → 정지", async () => {
      await page.click(".nav >> text=시간표");
      await page.click(".rail .ia >> text=지금");
      await page.click("dialog >> button:has-text('지금 방송')"); // 스피커로 바로 나가므로 한 번 묻는다
      await page.waitForSelector(".card.liveC");
      await page.waitForSelector("#livepill:not([hidden])");
      await page.click(".liveC .ia >> text=넘기기");
      await shot("07-onair");
      await page.click(".liveC .ia >> text=정지");
      await page.waitForSelector(".card.liveC", { state: "detached", timeout: 10000 });
    });

    await step("방송 기록 메뉴 없음", async () => {
      if (await page.locator(".nav >> text=기록").count()) throw new Error("기록 메뉴가 남아 있습니다");
    });

    await step("설정: 체크박스 저장, 어두운 테마", async () => {
      await page.click(".nav >> text=설정");
      await page.uncheck("#set-mute_others");
      await page.waitForSelector("text=저장됨");
      await page.check("#set-mute_others");
      await page.click(".radios >> text=어둡게");
      await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
      await page.click(".nav >> text=시간표");
      await page.waitForSelector(".cblock");
      await shot("08-calendar-dark");
      await page.click("#new-btn");
      await page.fill(".wz-active input", "어두운 화면");
      await page.keyboard.press("Enter");
      await shot("09-wizard-dark");
      await page.click('button[aria-label="닫기"]');
      await page.click("dialog >> text=그만하기");
      await page.click(".nav >> text=설정");
      await page.click(".radios >> text=시스템 설정");
    });

    await step("자동 방송 끄기 → 안내 띠 → 켜기", async () => {
      await page.click("#auto-switch");
      if ((await page.getAttribute("#auto-switch", "aria-checked")) !== "false") throw new Error("누른 즉시 스위치가 바뀌지 않습니다");
      await page.waitForSelector(".banner >> text=자동 방송이 꺼져 있습니다");
      await page.click(".banner >> text=켜기");
      await page.waitForSelector(".banner >> text=자동 방송이 꺼져 있습니다", { state: "detached" });
      // 빠르게 두 번 누르면 두 번 다 반영되어 원래(켜짐)로 돌아온다
      await page.click("#auto-switch");
      await page.click("#auto-switch");
      await page.waitForFunction(() => fetch("/api/status").then((r) => r.json()).then((j) => j.auto_broadcast === true));
      await page.waitForTimeout(600);
      const server = await page.evaluate(() => fetch("/api/status").then((r) => r.json()).then((j) => j.auto_broadcast));
      if (server !== true || (await page.getAttribute("#auto-switch", "aria-checked")) !== "true") throw new Error("두 번 누른 결과가 맞지 않습니다");
    });

    await step("특정 날짜: 쉬는 날만 고르면 다음으로 못 감", async () => {
      await page.click("#new-btn");
      await page.fill(".wz-active input", "쉬는 날 방송");
      await page.keyboard.press("Enter");
      await page.click(".wz-tile >> text=음성");
      await page.fill(".wz-active textarea", "안내합니다.");
      await page.keyboard.press("Enter");
      await page.click('.cp-item[aria-label="1번"]');
      await page.keyboard.press("Enter");
      await page.click(".wz-tile >> text=특정 날짜");
      await page.click('.wz-active button[aria-label="다음 달"]');
      const day = page.locator(".wz-active .rc-day:not([disabled])").nth(5);
      const iso = await day.getAttribute("data-date");
      await page.evaluate((d) => fetch("/api/days-off", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Jeongsi-Client": "1" }, body: JSON.stringify({ start: d, end: d }),
      }), iso);
      await day.click();
      await page.waitForSelector(".date-chip.off >> text=쉬는 날");
      if (!(await page.locator("#wz-next").isDisabled())) throw new Error("방송이 나가지 않는 날만 골랐는데 다음이 눌립니다");
      await shot("10-wizard-dayoff-date");
      await page.click('button[aria-label="닫기"]');
      await page.click("dialog >> text=그만하기");
    });

    await step("5분 차이 블록은 겹치지 않고 나란히", async () => {
      for (const [name, time] of [["겹침 가", "21:00"], ["겹침 나", "21:05"]]) {
        await page.evaluate(([n, t]) => fetch("/api/broadcasts", {
          method: "POST", headers: { "Content-Type": "application/json", "X-Jeongsi-Client": "1" },
          body: JSON.stringify({ name: n, steps: [{ kind: "tts", text: "안내" }], time: t, weekdays: [0, 1, 2, 3, 4, 5, 6] }),
        }), [name, time]);
      }
      await page.click(".nav >> text=방송 구성");
      await page.click(".nav >> text=시간표");
      const a = page.locator('.cal-col.today .cblock[aria-label*="겹침 가"]');
      const b = page.locator('.cal-col.today .cblock[aria-label*="겹침 나"]');
      await retry(() => a.scrollIntoViewIfNeeded());
      const [ra, rb] = [await a.boundingBox(), await b.boundingBox()];
      const overlap = ra.x < rb.x + rb.width && rb.x < ra.x + ra.width && ra.y < rb.y + rb.height && rb.y < ra.y + ra.height;
      if (overlap) throw new Error("가까운 블록이 서로 덮습니다");
      await shot("11-close-blocks");
      await a.click();
      await page.waitForSelector(".pop >> text=겹침 가");
      await page.keyboard.press("Escape");
    });

    await step("블록에서 Enter 두 번: 바로 방송되지 않음", async () => {
      const blk = page.locator('.cal-col.today .cblock[aria-label*="점심 방송"]');
      await retry(async () => { await blk.scrollIntoViewIfNeeded(); await blk.focus(); await page.keyboard.press("Enter"); await page.waitForSelector(".pop", { timeout: 2000 }); });
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      if (await page.locator("dialog[open]").count()) throw new Error("Enter 두 번에 확인 창이 떴습니다");
      if (await page.locator(".card.liveC").count()) throw new Error("Enter 두 번에 방송이 나갔습니다");
      await page.keyboard.press("Escape");
    });

    await step("바꾼 시각에서 이번만 끄기 → 되살리기는 바꾼 시각으로", async () => {
      const blk = page.locator('.cal-col.today .cblock[aria-label*="점심 방송"]');
      await blk.click();
      await page.click(".pop .ia >> text=이 날만 시각");
      await page.fill(".pop .tp-time", "2340");
      await page.keyboard.press("Enter");
      await page.waitForSelector('.cal-col.today .cblock.chg >> text=23:40');
      await page.waitForFunction(() => !document.querySelector("#toast.show"), null, { timeout: 10000 });
      await page.click('.cal-col.today .cblock.chg[aria-label*="점심 방송"]');
      await page.click(".pop .ia >> text=이번만 끄기");
      await page.waitForSelector('.cal-col.today .cblock.off[aria-label*="점심 방송"]');
      await page.click('.cal-col.today .cblock.off[aria-label*="점심 방송"]');
      await page.click(".pop .ia >> text=되살리기");
      await page.waitForSelector('.cal-col.today .cblock.chg >> text=23:40');
      await page.click('.cal-col.today .cblock.chg[aria-label*="점심 방송"]');
      await page.click(".pop .ia >> text=원래대로");
      await page.waitForSelector('.cal-col.today .cblock >> text=23:55');
    });

    await step("방송 끄기(켜짐 해제) → 흐리게 남음 → 다시 켜기", async () => {
      await page.click('.cal-col.today .cblock[aria-label*="점심 방송"]');
      await page.click(".pop .ia >> text=방송 편집");
      await page.uncheck('dialog input.toggle');
      await page.click("dialog >> button:has-text('저장')");
      await page.waitForSelector('.cal-col.today .cblock.disabled[aria-label*="점심 방송"]');
      await shot("12-disabled-block");
      await page.click('.cal-col.today .cblock.disabled[aria-label*="점심 방송"]');
      await page.click(".pop .ia >> text=다시 켜기");
      await page.waitForSelector('.cal-col.today .cblock.scheduled[aria-label*="점심 방송"]');
    });

    await step("방송 편집에서 이름만 고쳐도 분 단위 시각 유지", async () => {
      await page.evaluate(() => fetch("/api/broadcasts", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Jeongsi-Client": "1" },
        body: JSON.stringify({ name: "분 단위", steps: [{ kind: "tts", text: "안내" }], time: "23:58", weekdays: [0, 1, 2, 3, 4, 5, 6] }),
      }));
      await page.click(".nav >> text=방송 구성");
      await page.click(".nav >> text=시간표");
      await page.click('.cal-col.today .cblock[aria-label*="분 단위"]');
      await page.click(".pop .ia >> text=방송 편집");
      await page.fill("dialog .pg-name", "분 단위 안내");
      await page.click("dialog >> button:has-text('저장')");
      await page.waitForSelector('.cal-col.today .cblock[aria-label*="분 단위 안내"] >> text=23:58');
    });

    if (errors.length) throw new Error(`콘솔 오류: ${errors.join(" | ")}`);
    console.log(`E2E 통과: ${steps.length}개 흐름`);
  } catch (err) {
    await page.screenshot({ path: path.join(outDir, "failure.png") }).catch(() => {});
    console.error(`\nE2E 실패: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
