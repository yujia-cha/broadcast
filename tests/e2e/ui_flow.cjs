// 화면 E2E: 실제 서버(가짜 오디오)에 브라우저로 접속해 주요 흐름을 누른다.
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

  try {
    await step("첫 화면: 회차 없음 안내", async () => {
      await page.goto(base);
      await page.waitForSelector("text=아직 회차가 없습니다");
      await shot("01-empty");
    });

    await step("새 방송 만들기: 질문에 차례로 답하기", async () => {
      await page.click(".empty >> text=새 방송 만들기");
      await page.waitForSelector("#wz-q >> text=방송 이름을 정해 주세요");
      await page.fill(".wz-active input", "점심 안내");
      await page.keyboard.press("Enter");
      await page.waitForSelector("#wz-q >> text=무엇을 내보낼까요?");
      await page.click(".wz-choice >> text=음성 안내 + 음악");
      await page.waitForSelector("#wz-q >> text=읽어 줄 문구를 입력해 주세요");
      await page.fill(".wz-active textarea", "점심시간입니다. 손을 씻고 급식실로 이동해 주세요.");
      await page.click("#wz-next");
      await page.click(".wz-choice >> text=2번");
      await page.waitForSelector("#wz-q >> text=어떤 파일을 틀까요?");
      const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click(".wz-active >> text=파일 올리기")]);
      await chooser.setFiles(path.join(assetDir, "chime.wav"));
      await page.waitForSelector("#wz-q >> text=몇 번 틀까요?");
      await page.click(".wz-choice >> text=1번");
      await page.waitForSelector("#wz-q >> text=몇 시에 내보낼까요?");
      await shot("02-wizard-step");
      await page.fill(".wz-active input[type=time]", "23:59");
      await page.keyboard.press("Enter");
      await page.click(".wz-choice >> text=매일");
      await page.click(".wz-choice >> text=오늘부터");
      await page.click(".wz-choice >> text=계속");
      await page.waitForSelector("#wz-q >> text=이대로 만들까요?");
      await shot("02-wizard-confirm");
    });

    await step("확인 화면에서 이름 고치기 → 다시 확인으로", async () => {
      await page.click('.wz-row[aria-label="이름 고치기"]');
      await page.fill(".wz-active input", "점심 방송");
      await page.click("#wz-next");
      await page.waitForSelector("#wz-q >> text=이대로 만들까요?");
      await page.waitForSelector(".wz-row >> text=점심 방송");
    });

    await step("확인에 체크해야 만들기 가능 → 예약 완료", async () => {
      if (!(await page.locator(".wz-cta >> text=만들기").isDisabled())) throw new Error("확인 전인데 만들기가 눌립니다");
      await page.check("#wz-agree");
      await page.click(".wz-cta >> text=만들기");
      await page.waitForSelector("#wz-q >> text=예약했어요");
      await shot("03-wizard-done");
      await page.click("text=시간표 보기");
      await page.waitForSelector(".tt .rowhd >> text=점심 방송");
      await shot("04-timetable");
    });

    await step("방송 구성 편집: 단계 복제·삭제·저장", async () => {
      await page.click(".nav >> text=방송 구성");
      await page.waitForSelector(".editor-head input");
      if ((await page.locator(".step").count()) !== 2) throw new Error("마법사가 만든 단계 수가 다릅니다");
      await page.click('button[aria-label="2단계 복제"]');
      if ((await page.locator(".step").count()) !== 3) throw new Error("단계 복제가 되지 않았습니다");
      await page.click('button[aria-label="3단계 삭제"]');
      await page.click(".editor-foot >> text=저장");
      await page.waitForSelector("text=저장했습니다.");
    });

    await step("전체 미리듣기 → 정지", async () => {
      await page.click("text=전체 미리듣기");
      await page.waitForSelector(".editor-foot >> text=정지");
      await page.click(".editor-foot >> text=정지");
      await page.waitForSelector("text=전체 미리듣기");
    });

    await step("소리 파일 관리: 쓰는 파일은 삭제 불가", async () => {
      await page.click("text=올린 소리 파일 1개 관리");
      await page.waitForSelector("dialog >> text=점심 방송");
      if (!(await page.locator("dialog .link:has-text('삭제')").isDisabled())) throw new Error("쓰는 파일인데 삭제할 수 있습니다");
      await page.click("dialog >> text=닫기");
      await page.click(".nav >> text=시간표");
      await page.waitForSelector(".tt .rowhd");
    });

    await step("같은 시각 회차 겹침 경고", async () => {
      await page.click(".addrow >> text=회차 추가");
      await page.fill('dialog input[placeholder="예: 점심 안내"]', "겹치는 회차");
      await page.fill("dialog input[type=time]", "23:59");
      await page.click("dialog >> text=저장");
      await page.waitForSelector("dialog >> text=같은 시각(23:59)");
      await page.click("dialog >> text=취소");
    });

    await step("오늘 칸만 시각 바꾸기", async () => {
      await page.click(".cell.today:not(.none) button");
      const past = await page.locator("text=지난 회차라 바꿀 수 없습니다").count();
      if (past) return console.log("(지난 시각이라 건너뜀)");
      await page.click(".radios >> text=바꾸기");
      await page.fill(".rail input[type=time]", "23:58");
      await page.click("text=이 날짜에 적용");
      await page.waitForSelector(".cell.chg >> text=원래 23:59");
      await shot("04-changed");
    });

    await step("이번 방송 끄기 → 되돌리기", async () => {
      await page.click("text=이번 방송 끄기");
      await page.waitForSelector(".notice >> text=되돌리기");
      await page.click(".notice >> text=되돌리기");
      await page.waitForSelector("text=되돌렸습니다.");
    });

    await step("하루 쉬기 → 해제", async () => {
      const header = page.locator(".dayhd").first();
      await header.click();
      await page.fill('.rail input[placeholder="예: 개교기념일"]', "개교기념일");
      await page.click("text=이 날 쉬기");
      await page.waitForSelector(".dayhd >> text=쉼 개교기념일");
      await header.click();
      await page.click("text=쉬는 날 해제");
      await page.waitForSelector("text=쉬는 날을 해제했습니다.");
    });

    await step("쉬는 기간 추가·삭제", async () => {
      await page.click(".weekbar >> text=쉬는 날");
      await page.fill('dialog input[placeholder="예: 겨울 방학"]', "겨울 방학");
      await page.click("dialog >> button:has-text('추가')");
      await page.waitForSelector("dialog >> text=겨울 방학");
      await page.click("dialog .notice >> text=삭제");
      await page.waitForSelector("dialog >> text=등록한 쉬는 날이 없습니다.");
      await page.click("dialog >> text=닫기");
    });

    await step("지금 방송 → 다음 단계로 → 방송 끄기", async () => {
      await page.click("text=지금 방송");
      await page.waitForSelector(".card.liveC");
      await page.waitForSelector("#livepill:not([hidden])");
      await page.click("text=다음 단계로");
      await shot("05-onair");
      await page.click(".liveC >> text=방송 끄기");
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
      await shot("07-settings-dark");
      await page.click(".nav >> text=시간표");
      await page.waitForSelector(".tt .rowhd");
      await shot("08-timetable-dark");
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
