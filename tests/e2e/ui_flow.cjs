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
      for (let i = 0; i < 11; i++) await page.click('button[aria-label="1시간 늦게"]');
      await page.focus(".tp-pin");
      for (let i = 0; i < 11; i++) await page.keyboard.press("ArrowRight");
      if ((await page.textContent(".tp-time")) !== "23:55") throw new Error(`시각이 다릅니다: ${await page.textContent(".tp-time")}`);
      await shot("02-wizard-time");
      await page.keyboard.press("Enter");
      await page.click(".chip-btn >> text=매일");
      await page.waitForSelector(".rc-grid");
      await page.click("#wz-next");
      await page.waitForSelector(".ticket");
      await shot("03-wizard-ticket");
    });

    await step("티켓에서 이름 고치기 → 다시 확인", async () => {
      await page.click('.tk-row[aria-label="방송 이름 고치기"]');
      await page.fill(".wz-active input", "점심 방송");
      await page.click("#wz-next");
      await page.waitForSelector(".ticket >> text=점심 방송");
    });

    await step("확인 체크 후 만들기 → 시간표에 블록", async () => {
      if (!(await page.locator(".wz-cta >> text=만들기").isDisabled())) throw new Error("확인 전인데 만들기가 눌립니다");
      await page.check("#wz-agree");
      await page.click(".wz-cta >> text=만들기");
      await page.waitForSelector("#wz-q >> text=예약했어요");
      await page.click("text=시간표 보기");
      await page.waitForSelector('.cblock[aria-label*="점심 방송"]');
      await shot("04-calendar");
    });

    await step("블록을 끌어 오늘만 시각 바꾸기", async () => {
      const blk = page.locator(".cal-col.today .cblock.next");
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
    });

    await step("블록 누르기 → 원래대로", async () => {
      await page.click(".cal-col.today .cblock.chg");
      await page.click(".pop .ia >> text=원래대로");
      await page.waitForSelector(".cal-col.today .cblock.next >> text=23:55");
    });

    await step("블록 누르기 → 이 날 쉬기 → 되살리기", async () => {
      await page.click(".cal-col.today .cblock.next");
      await shot("05-popover");
      await page.click(".pop .ia >> text=이 날 쉬기");
      await page.waitForSelector(".cal-col.today .cblock.off");
      await page.click(".cal-col.today .cblock.off");
      await page.click(".pop .ia >> text=되살리기");
      await page.waitForSelector(".cal-col.today .cblock.next");
    });

    await step("이번 끄기 → 되돌리기", async () => {
      await page.click(".rail .ia >> text=이번 끄기");
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
      await page.click(".weekbar >> text=쉬는 날");
      const days = page.locator("dialog .rc-day:not([disabled])");
      await days.nth(10).click();
      await days.nth(12).click();
      await page.fill('dialog input[aria-label="메모"]', "겨울 방학");
      await page.click("dialog >> button:has-text('추가')");
      await page.waitForSelector("dialog .off-chip >> text=겨울 방학");
      await page.click('dialog .off-x[aria-label="삭제"]');
      await page.waitForSelector("dialog .off-chip", { state: "detached" });
      await page.click("dialog >> text=닫기");
    });

    await step("매주 일정 편집 열고 저장", async () => {
      await page.click(".cal-col.today .cblock.next");
      await page.click(".pop .ia >> text=매주");
      await page.waitForSelector("dialog .wdp");
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
      if (!(await page.locator("dialog .off-x").isDisabled())) throw new Error("쓰는 파일인데 지울 수 있습니다");
      await page.click("dialog >> text=닫기");
    });

    await step("지금 방송 → 다음 → 끄기", async () => {
      await page.click(".nav >> text=시간표");
      await page.click(".rail .ia >> text=지금");
      await page.waitForSelector(".card.liveC");
      await page.waitForSelector("#livepill:not([hidden])");
      await page.click(".liveC .ia >> text=다음");
      await shot("07-onair");
      await page.click(".liveC .ia >> text=끄기");
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
      await page.waitForSelector(".banner >> text=자동 방송이 꺼져 있습니다");
      await page.click(".banner >> text=켜기");
      await page.waitForSelector(".banner >> text=자동 방송이 꺼져 있습니다", { state: "detached" });
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
