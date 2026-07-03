/**
 * TikTok Lite 포인트 파머 — 코어 엔진 v1.1
 * ------------------------------------------------------------------
 * 자동화 흐름 + 화면 검증/재시도 + 오류 복구 + 무한 파밍 + 캘리브레이션.
 * UI(main.js)에서 start()/stop()/calibrate()/stats() 를 호출합니다.
 */
"use strict";

var C = require("./config.js");
function cfg() { return C.get(); }

var W = device.width;
var H = device.height;

// ── 로그(로테이션 포함) ──────────────────────────────────────
var LOG_MAX = 512 * 1024; // 512KB 넘으면 뒤쪽 100KB만 유지
var LOG_PATH = (function () {
  var candidates = ["/sdcard/ttl_farmer.log"];
  try { candidates.push(files.join(files.cwd(), "ttl_farmer.log")); } catch (e) {}
  for (var i = 0; i < candidates.length; i++) {
    try { files.append(candidates[i], ""); return candidates[i]; } catch (e) {}
  }
  return null;
})();
function rotateLog() {
  if (!LOG_PATH) return;
  try {
    if (new java.io.File(LOG_PATH).length() > LOG_MAX) {
      files.write(LOG_PATH, files.read(LOG_PATH).slice(-100 * 1024));
    }
  } catch (e) {}
}
var logSink = null;
function setLogSink(fn) { logSink = fn; }
function ts() {
  var d = new Date();
  return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) +
         ":" + ("0" + d.getSeconds()).slice(-2);
}
function log(msg) {
  var line = "[" + ts() + "] " + msg;
  console.log(line);
  try { if (logSink) logSink(line); } catch (e) {}
  if (LOG_PATH) { try { files.append(LOG_PATH, line + "\n"); } catch (e) {} }
}
function logPath() { return LOG_PATH || "(파일 로그 사용 불가)"; }

// ── 대기/랜덤(사람처럼, 중단 가능) ───────────────────────────
function rnd(a, b) { return a + Math.random() * (b - a); }
function jitter(ms) {
  return cfg().humanize ? Math.round(ms * rnd(0.85, 1.15)) : ms;
}
function napChunked(ms, isRunning) {
  var end = Date.now() + ms;
  while (Date.now() < end) {
    if (isRunning && !isRunning()) return;
    sleep(Math.min(500, end - Date.now()));
  }
}

// ── 탐색: 전 후보 동시 폴링(논블로킹) ────────────────────────
// 짧은 후보(≤2자)는 완전일치만 — textContains("X") 오탭 방지
function findAny(list, timeoutMs) {
  var end = Date.now() + timeoutMs;
  do {
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var n = text(t).findOnce() || desc(t).findOnce()
           || (t.length > 2 ? textContains(t).findOnce() : null);
      if (n) return { node: n, matched: t };
    }
    sleep(300);
  } while (Date.now() < end);
  return null;
}
function clickNode(node) {
  if (node.click()) return true;
  var b = node.bounds();
  click(b.centerX(), b.centerY());
  return true;
}
function tapText(list, label, timeoutMs) {
  var f = findAny(list, timeoutMs === undefined ? cfg().retry.findTimeoutMs : timeoutMs);
  if (!f) return false;
  log((label || "텍스트") + " '" + f.matched + "' 클릭");
  clickNode(f.node);
  sleep(jitter(cfg().timing.shortWait));
  return true;
}
function tapRatio(ratio, label) {
  // humanize 시 ±5px 오프셋으로 매번 같은 픽셀을 누르지 않음
  var ox = cfg().humanize ? rnd(-5, 5) : 0;
  var oy = cfg().humanize ? rnd(-5, 5) : 0;
  var x = Math.round(ratio.x * W + ox), y = Math.round(ratio.y * H + oy);
  log((label || "탭") + " → (" + x + ", " + y + ")");
  click(x, y);
  sleep(jitter(cfg().timing.shortWait));
}
function tapTextOrCoord(list, coord, label) {
  if (list && tapText(list, label)) return true;
  if (coord) { tapRatio(coord, label + "(좌표)"); return true; }
  log(label + " 실패: 대상 못 찾음");
  return false;
}
/**
 * 팝업 정리 — "헤매지 않는" 안전 버전.
 * 규칙: 팝업이 확실할 때만 손댄다. 애매하면 아무것도 안 누른다(오탭 방지).
 *  1) 텍스트/desc 닫기(닫기/✕/취소/건너뛰기/확인) — 항상 안전
 *  2) '리워드 페이지 표식'이 없고 '모달 이벤트 팝업 표식'만 있을 때에 한해
 *     → 이벤트 팝업 ✕ 좌표를 눌러 닫음(리워드 페이지에선 절대 좌표 안 누름)
 *  3) 닫을 게 없으면 즉시 종료(무한 blind 탭 금지)
 * @return true = 정상, false = CAPTCHA로 중단
 */
function clearAllPopups(label) {
  var rounds = cfg().popup.maxRounds;
  var gap = cfg().popup.roundGapMs;
  for (var round = 0; round < rounds; round++) {
    if (detectCaptcha()) return false;
    // 1) 안전한 텍스트/desc 닫기
    if (tapText(cfg().texts.close, (label || "팝업") + " 닫기", 600)) {
      sleep(gap); continue;
    }
    // 2) 리워드 페이지가 아니고, 모달 이벤트 팝업만 떠 있는 경우에만 좌표 사용
    var onPage = !!findAny(cfg().texts.pageMarker, 300);
    var eventOnly = !onPage && !!findAny(cfg().texts.eventPopup, 300);
    if (eventOnly) {
      var spots = cfg().coords.eventCloseSpots || [];
      var closed = false;
      for (var s = 0; s < spots.length; s++) {
        tapRatio(spots[s], "이벤트팝업 ✕후보" + (s + 1));
        sleep(gap);
        if (detectCaptcha()) return false;
        if (!findAny(cfg().texts.eventPopup, 400)) { closed = true; break; }
      }
      if (!closed) { back(); sleep(800); } // 좌표로 못 닫으면 뒤로가기로
      continue;
    }
    // 3) 더 닫을 것 없음 → 종료(헤매지 않기)
    break;
  }
  return true;
}

// 하단 스티키 배너(야시장 챌린지 등)를 감지됐을 때만 ✕로 닫음
function closeStickyBanner() {
  if (findAny(cfg().texts.banner, 300)) {
    tapRatio(cfg().coords.bannerClose, "스티키 배너 ✕");
    sleep(500);
  }
}
function checkAndClosePopup() {
  // 시청 중 팝업: 오탭 방지를 위해 텍스트로만 닫음
  if (detectCaptcha()) return false;
  if (tapText(cfg().texts.close, "시청중 팝업", 300)) {
    sleep(jitter(cfg().timing.afterPopupClose)); return true;
  }
  return false;
}
// CAPTCHA/보안인증/이상행동 화면 감지 — 있으면 파밍을 안전 정지시킴
function detectCaptcha() {
  var f = findAny(cfg().texts.captcha, 200);
  if (!f) return false;
  log("🛑 보안인증/CAPTCHA 감지('" + f.matched + "') → 자동화 정지. 사람이 직접 처리 필요");
  captchaHit = true;
  running = false; // 루프 즉시 종료
  try { device.vibrate(800); } catch (e) {}
  toast("보안인증 감지! 직접 인증 후 다시 시작하세요");
  return true;
}
function swipeToNextVideo() {
  // 매번 궤적/속도를 조금씩 다르게(탐지 완화)
  var x1 = Math.round(W * rnd(0.42, 0.58));
  var x2 = x1 + Math.round(rnd(-25, 25));
  var y1 = Math.round(H * rnd(0.70, 0.78));
  var y2 = Math.round(H * rnd(0.20, 0.28));
  swipe(x1, y1, x2, y2, Math.round(rnd(320, 600)));
  sleep(Math.round(rnd(600, 1200)));
}

// ── 앱 상태/복구 ─────────────────────────────────────────────
function isOurApp(pkg) {
  if (!pkg) return false;
  var c = cfg().packageCandidates || [];
  for (var i = 0; i < c.length; i++) if (pkg === c[i]) return true;
  return false;
}
function launchApp() {
  if (!app.launchApp(cfg().appName)) {
    var c = cfg().packageCandidates;
    for (var i = 0; i < c.length; i++) if (app.launchPackage(c[i])) break;
  }
  sleep(cfg().timing.afterLaunch);
}
function ensureForeground(forceLaunch) {
  if (forceLaunch) launchApp();
  if (isOurApp(currentPackage())) return true;
  log("포그라운드 아님(" + currentPackage() + ") → 재실행");
  launchApp();
  return isOurApp(currentPackage());
}
function keepAwake() {
  if (cfg().keepScreenOn) { try { device.keepScreenOn(24 * 60 * 60 * 1000); } catch (e) {} }
}
function releaseAwake() { try { device.cancelKeepingAwake(); } catch (e) {} }

// ── 통계(제어판 표시용) ──────────────────────────────────────
var stat = { startedAt: 0, cycles: 0, lastError: "" };
var captchaHit = false;
function stats() {
  return {
    cycles: stat.cycles,
    uptimeMin: stat.startedAt ? Math.floor((Date.now() - stat.startedAt) / 60000) : 0,
    lastError: stat.lastError,
    captcha: captchaHit,
  };
}

// ── 리워드(초록) 페이지 동작 — 텍스트 우선 ───────────────────
function stepCloseApp() { log("앱 종료(홈으로)"); home(); sleep(cfg().timing.shortWait); }

function watchVideos(durationMs, isRunning) {
  log("영상 시청: " + Math.round(durationMs / 1000) + "초");
  var end = Date.now() + durationMs;
  while (Date.now() < end) {
    if (isRunning && !isRunning()) return;
    if (!ensureForeground(false)) { sleep(3000); continue; }
    napChunked(jitter(cfg().timing.scrollIntervalMs), isRunning);
    if (isRunning && !isRunning()) return;
    checkAndClosePopup();
    swipeToNextVideo();
  }
}

// 노드의 오른쪽(같은 카드의 버튼 영역)을 탭 — 타이머 카드처럼 버튼이 우측에 있을 때
function tapRightOf(node, label) {
  var b = node.bounds();
  var x = Math.round(W * 0.80), y = b.centerY();
  log(label + " 우측 버튼 → (" + x + ", " + y + ")");
  click(x, y);
  sleep(jitter(cfg().timing.shortWait));
}

// 리워드 페이지에 있는지 확인. 없으면 하단 "포인트" 탭(텍스트→좌표)으로 진입(최대 3회)
function ensureOnRewardsPage() {
  for (var i = 1; i <= 3; i++) {
    if (findAny(cfg().texts.pageMarker, 1500)) return true;
    if (!tapText(cfg().texts.pointsTab, "포인트 탭", 1500)) {
      tapRatio(cfg().coords.pointButton, "포인트 탭(좌표)");
    }
    clearAllPopups("이벤트");
    if (findAny(cfg().texts.pageMarker, 2500)) { log("리워드 페이지 확인됨"); return true; }
    log("리워드 페이지 미확인 → 재시도 " + i + "/3");
    ensureForeground(false); sleep(1000);
  }
  log("⚠ 리워드 페이지 진입 실패");
  return false;
}

// 리워드 팝업 처리: 받기 → 확인(연속 팝업 대비 반복)
function collectPopup() {
  for (var i = 0; i < 3; i++) {
    var got = false;
    if (tapText(cfg().texts.receive, "받기", 1200)) got = true;
    if (tapText(cfg().texts.confirm, "확인", 1000)) got = true;
    if (!got) break;
    sleep(cfg().timing.afterPopupClose);
  }
}

// 광고 화면인지 확인(상단 "15초 시청하고 30포인트 받기")
function inAdScreen() {
  return !!findAny(cfg().texts.adMarker, 500);
}

// 광고 시청 후 닫기: 광고 진입 확인 → 기본대기 → X(실측 우상단) 폴링 → 복귀
// 주의: 광고 안의 "지금 쇼핑하기/다운로드" 등은 절대 누르지 않음(알려진 X만 누름)
function watchAdThenClose() {
  if (!inAdScreen()) {
    log("광고 화면 미진입(이미 소진되었거나 카운트다운 중) → 스킵");
    return false;
  }
  log("광고 시청 " + Math.round(cfg().timing.adBaseWaitMs / 1000) + "초 대기...");
  napChunked(cfg().timing.adBaseWaitMs, isRunningFlag);
  var end = Date.now() + cfg().timing.adExtraWaitMs;
  while (Date.now() < end && running) {
    if (detectCaptcha()) return false;
    if (findAny(cfg().texts.pageMarker, 500)) { log("광고 종료(페이지 복귀)"); break; }
    tapRatio(cfg().coords.adClose, "광고 X(우상단)");
    sleep(1500);
    if (!inAdScreen()) { back(); sleep(800); } // X 눌렀는데 랜딩페이지로 갔으면 뒤로
  }
  collectPopup(); // 광고 후 리워드 수령 팝업
  return true;
}

// 리워드 페이지 스크롤(위로 올리기 / 아래로 내리기) — 페이지 안에서만 스와이프
function scrollRewardsUp()   { swipe(Math.round(W*0.5), Math.round(H*0.35), Math.round(W*0.5), Math.round(H*0.75), 500); sleep(700); }
function scrollRewardsDown() { swipe(Math.round(W*0.5), Math.round(H*0.72), Math.round(W*0.5), Math.round(H*0.32), 500); sleep(700); }
function scrollRewardsTop()  { for (var i=0;i<5;i++) scrollRewardsUp(); }

// 리워드 페이지를 위→아래로 훑으며 준비된 리워드를 모두 수확
// 텍스트로만 누르므로(포인트받기/받기/출석하기/광고보상) 오탭·헤맴 없음
function harvestRewards(doAttendance, likedVideo) {
  if (!ensureOnRewardsPage()) return;
  clearAllPopups("초기 팝업");
  closeStickyBanner();

  // 출석하기(하루 1회)
  if (doAttendance && running && tapText(cfg().texts.attendance, "출석하기", 1500)) {
    sleep(cfg().timing.afterTapReward);
    collectPopup(); stat.cycles++;
    ensureOnRewardsPage(); closeStickyBanner();
  }

  // 페이지를 위에서부터 훑으며 '포인트 받기/받기'와 '광고 보상'을 처리
  scrollRewardsTop();
  var idlePasses = 0;
  for (var pass = 0; pass < 8 && running; pass++) {
    if (detectCaptcha()) return;
    closeStickyBanner();
    var didSomething = false;

    // 1) 준비된 수령 버튼(포인트 받기/받기)
    if (tapText(cfg().texts.receive, "리워드 수령", 900)) {
      collectPopup(); stat.cycles++;
      ensureOnRewardsPage(); closeStickyBanner(); scrollRewardsTop();
      didSomething = true;
    }
    // 2) 광고 보면 추가 보상
    else if (tapText(cfg().texts.adReward, "광고 보상", 900)) {
      sleep(cfg().timing.afterTapReward);
      if (detectCaptcha()) return;
      if (watchAdThenClose()) stat.cycles++;
      ensureOnRewardsPage(); closeStickyBanner(); scrollRewardsTop();
      didSomething = true;
    }

    if (!didSomething) {
      scrollRewardsDown();
      if (++idlePasses >= 3) { log("더 받을 리워드 없음 → 수확 종료"); break; }
    } else {
      idlePasses = 0;
    }
  }
}

// 20분 대기: '시청하기'로 피드에 가서 영상 시청(시청 게이지 충전) + 좋아요 1회
// @return 좋아요를 눌렀으면 true
function waitNextCycle() {
  var liked = false;
  if (cfg().watchVideosForTimer) {
    // '시청하기' 버튼으로 피드 진입(없으면 뒤로가기로)
    if (!tapText(cfg().texts.videoStart, "시청하기", 2000)) { back(); sleep(1500); }
    // 시청 시작 직후 좋아요 1회(좋아요 미션용)
    sleep(3000);
    tapRatio(cfg().coords.feedLike, "피드 좋아요(미션)");
    liked = true;
    watchVideos(cfg().timing.betweenCycleMs, isRunningFlag);
  } else {
    napChunked(cfg().timing.betweenCycleMs, isRunningFlag);
  }
  return liked;
}

// ── 엔진(스레드) ─────────────────────────────────────────────
var running = false;
var worker = null;

function safe(name, fn) {
  try { fn(); }
  catch (e) {
    stat.lastError = name + ": " + e;
    log("⚠ " + name + " 오류: " + e);
    try { ensureForeground(false); } catch (e2) {}
  }
}
function isRunningFlag() { return running; }

function runOnce() {
  log("[모드] 한 바퀴 수확");
  safe("실행", function () { ensureForeground(true); });
  safe("팝업", function () { clearAllPopups("초기 이벤트"); });
  safe("수확", function () { harvestRewards(true, false); });
  safe("종료", stepCloseApp);
  log("한 바퀴 완료");
}

function runFarm() {
  log("[모드] 무한 파밍 시작");
  safe("실행", function () { ensureForeground(true); });
  safe("팝업", function () { clearAllPopups("초기 이벤트"); });
  var lastAtt = 0;
  var liked = false;
  while (running) {
    if (!ensureForeground(false)) { sleep(3000); continue; }
    var doAtt = (Date.now() - lastAtt > cfg().timing.dailyAttendanceMs);
    (function (att, lk) {
      safe("수확", function () { harvestRewards(att, lk); });
    })(doAtt, liked);
    if (doAtt) lastAtt = Date.now();
    if (!running) break;
    liked = false;
    safe("대기", function () { liked = waitNextCycle(); }); // 20분 시청+좋아요
  }
  log("파밍 정지");
}

function start() {
  if (running) { log("이미 실행 중"); return; }
  running = true;
  captchaHit = false;
  stat.startedAt = Date.now(); stat.cycles = 0; stat.lastError = "";
  rotateLog();
  keepAwake();
  log("▶ 시작 (" + cfg().mode + ") | 로그: " + logPath());
  worker = threads.start(function () {
    try { (cfg().mode === "once") ? runOnce() : runFarm(); }
    catch (e) { log("치명적 오류: " + e); }
    running = false;
    releaseAwake();
    log("■ 종료됨");
  });
}
function stop() {
  if (!running) return;
  running = false;
  releaseAwake();
  log("정지 요청...");
  if (worker) { try { worker.interrupt(); } catch (e) {} }
}
function isRunning() { return running; }

// ── 좌표 캘리브레이션(화면을 탭해서 좌표 저장) ───────────────
// v2: 대부분 텍스트로 처리. 좌표는 3곳만(기본값도 실측이라 대개 그대로 OK)
var CAL_TARGETS = [
  ["pointButton", "하단 '포인트' 탭 (좌측 두번째)"],
  ["adClose", "광고 화면 닫기 X (우측 상단)"],
  ["feedLike", "영상 피드의 하트(좋아요)"],
];
function calibrate() {
  threads.start(function () {
    log("좌표설정 시작 — 안내대로 각 위치를 탭하세요 (30초 무응답 시 취소)");
    for (var i = 0; i < CAL_TARGETS.length; i++) {
      var key = CAL_TARGETS[i][0], label = CAL_TARGETS[i][1];
      var pt = captureOneTap("[" + (i + 1) + "/" + CAL_TARGETS.length + "]\n" + label + "\n위치를 탭하세요");
      if (!pt) { toast("좌표설정 취소"); log("좌표설정 취소"); return; }
      cfg().coords[key] = {
        x: Math.round(pt.x / W * 1000) / 1000,
        y: Math.round(pt.y / H * 1000) / 1000,
      };
      C.save();
      log("저장: " + key + " = " + cfg().coords[key].x + ", " + cfg().coords[key].y);
      sleep(500);
    }
    toast("좌표설정 완료!");
    log("좌표설정 완료 — [시작]을 누르세요");
  });
}
// 전체화면 오버레이로 한 번의 탭 좌표를 잡음
function captureOneTap(msg) {
  var result = { pt: null, done: false };
  var win = null;
  ui.run(function () {
    win = floaty.rawWindow(
      <frame id="cover" w="*" h="*" bg="#55000000">
        <text id="hint" text={msg} textColor="#ffffff" textSize="16sp" gravity="center" padding="24"/>
      </frame>
    );
    win.setSize(-1, -1);
    win.setTouchable(true);
    win.cover.setOnTouchListener(function (v, ev) {
      if (ev.getAction() === ev.ACTION_DOWN) {
        result.pt = { x: Math.round(ev.getRawX()), y: Math.round(ev.getRawY()) };
        result.done = true;
      }
      return true;
    });
  });
  var t0 = Date.now();
  while (!result.done && Date.now() - t0 < 30000) sleep(100);
  try { if (win) ui.run(function () { win.close(); }); } catch (e) {}
  return result.pt;
}

module.exports = {
  setLogSink: setLogSink,
  start: start, stop: stop, isRunning: isRunning,
  calibrate: calibrate, stats: stats,
  log: log, logPath: logPath,
};
