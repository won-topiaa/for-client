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
// 한 번의 팝업 닫기 시도(텍스트 우선 → 좌표 후보들 순차). 닫았으면 true
function closeOnce(label) {
  if (tapText(cfg().texts.close, (label || "팝업") + " 닫기", 600)) {
    sleep(jitter(cfg().timing.afterPopupClose)); return true;
  }
  return false;
}
/**
 * 첫 진입 팝업(매번 다른 10개+ 이벤트)을 확실히 처리.
 *  1) CAPTCHA/보안인증이면 즉시 중단(사람 개입 필요) → 파밍 정지
 *  2) 텍스트 닫기 반복 → 안 되면 좌표 후보 X들을 순차로 눌러봄
 *  3) 더 이상 닫을 팝업이 없을 때까지(최대 maxRounds회) 반복
 * @return true = 정상 처리, false = CAPTCHA로 중단됨
 */
function clearAllPopups(label) {
  var p = cfg().popup;
  for (var round = 0; round < p.maxRounds; round++) {
    if (detectCaptcha()) return false;               // 보안인증이면 즉시 멈춤
    if (closeOnce(label)) { sleep(p.roundGapMs); continue; } // 텍스트로 닫힘 → 다음 팝업 확인
    // 텍스트로 못 닫음 → 좌표 후보 X를 하나씩 눌러봄
    var closedBySpot = false;
    for (var s = 0; s < p.closeSpots.length; s++) {
      tapRatio(p.closeSpots[s], (label || "팝업") + " X후보" + (s + 1));
      sleep(p.roundGapMs);
      if (detectCaptcha()) return false;
      // 닫기 텍스트가 사라졌으면 성공으로 보고 다음 라운드
      if (!findAny(cfg().texts.close, 400)) { closedBySpot = true; break; }
    }
    if (!closedBySpot) { log("남은 팝업 없음(또는 미확인) → 팝업 처리 종료"); break; }
  }
  return true;
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

// ── 단계별 동작 ──────────────────────────────────────────────
function stepHeart()      { tapRatio(cfg().coords.heart, "우측중간 하트"); }
function stepAttendance() { tapTextOrCoord(cfg().texts.attendance, cfg().coords.attendanceCheck, "출석체크"); }
function stepCloseApp()   { log("앱 종료(홈으로)"); home(); sleep(cfg().timing.shortWait); }

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

// 4~5: 포인트 화면 진입 — 실제로 진입했는지 검증하고 최대 3회 재시도
function openPointsVerified() {
  var markers = cfg().texts.timer.concat(cfg().texts.receive, cfg().texts.watchAd);
  for (var i = 1; i <= 3; i++) {
    tapRatio(cfg().coords.pointButton, "포인트 버튼");        // 4
    clearAllPopups("포인트/이벤트");                          // 5
    if (findAny(markers, 3000)) { log("포인트 화면 확인됨"); return true; }
    log("포인트 화면 미확인 → 재시도 " + i + "/3");
    back(); sleep(1000);
    ensureForeground(false);
  }
  log("⚠ 포인트 화면 진입 실패(좌표설정 확인 필요)");
  return false;
}

// 광고 시청: 기본 대기 후, 닫기/복귀를 최대 adExtraWaitMs 동안 폴링(가변 길이 광고 대응)
function watchAdAndExit() {
  log("광고 시청 " + Math.round(cfg().timing.afterAdWatch / 1000) + "초...");
  napChunked(cfg().timing.afterAdWatch, isRunningFlag);
  var extra = cfg().timing.adExtraWaitMs || 45000;
  var end = Date.now() + extra;
  while (Date.now() < end && running) {
    if (tapText(cfg().texts.close, "광고 닫기", 300)) { sleep(1000); break; }
    sleep(1000);
  }
  tapRatio(cfg().coords.topLeftP, "좌측상단 p");               // 8
}

// 6~10: 포인트 적립 사이클
function claimCycle() {
  log("=== 적립 사이클 ===");
  tapTextOrCoord(cfg().texts.timer, cfg().coords.timer, "타이머"); // 6
  tapText(cfg().texts.receive, "받기");
  if (tapText(cfg().texts.watchAd, "광고보기")) {                 // 7
    watchAdAndExit();                                             // 8
    tapRatio(cfg().coords.videoLike, "영상 좋아요");              // 9
    sleep(jitter(cfg().timing.shortWait));
    tapText(cfg().texts.receive, "받기");
  } else {
    log("광고보기 없음 → 스킵");
  }
  back();                                                         // 10
  sleep(jitter(cfg().timing.shortWait));
  stat.cycles++;
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
  log("[모드] 한 바퀴 실행");
  safe("실행", function () { ensureForeground(true); });          // 1
  safe("팝업", function () { clearAllPopups("출석/이벤트"); });       // 2
  safe("하트", stepHeart);                                        // 3a
  safe("시청", function () { watchVideos(cfg().timing.watchDurationMs, isRunningFlag); }); // 3b
  safe("포인트진입", openPointsVerified);                         // 4~5
  var n = Math.max(1, cfg().maxCycles);
  for (var i = 1; i <= n && running; i++) {
    log("사이클 " + i + "/" + n);
    safe("적립", claimCycle);                                     // 6~10
    if (i < n) napChunked(cfg().timing.betweenCycleMs, isRunningFlag);
  }
  safe("출석", stepAttendance);                                   // 11
  safe("종료", stepCloseApp);                                     // 12
  log("한 바퀴 완료");
}

function runFarm() {
  log("[모드] 무한 파밍 시작");
  safe("실행", function () { ensureForeground(true); });
  safe("팝업", function () { clearAllPopups("출석/이벤트"); });
  safe("하트", stepHeart);
  var lastAtt = 0;
  while (running) {
    if (!ensureForeground(false)) { sleep(3000); continue; }
    safe("포인트진입", openPointsVerified);
    safe("적립", claimCycle);
    if (Date.now() - lastAtt > cfg().timing.dailyAttendanceMs) {
      safe("출석", stepAttendance); lastAtt = Date.now();
    }
    // 다음 타이머까지 영상 시청하며 대기(타이머가 시청으로 충전됨)
    safe("시청대기", function () { watchVideos(cfg().timing.betweenCycleMs, isRunningFlag); });
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
var CAL_TARGETS = [
  ["popupClose", "팝업 닫기(X) 위치"],
  ["heart", "우측 중간 하트"],
  ["pointButton", "좌측 하단 포인트 버튼"],
  ["timer", "타이머 버튼"],
  ["topLeftP", "좌측 상단 p"],
  ["videoLike", "영상 좋아요"],
  ["attendanceCheck", "출석체크 버튼"],
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
