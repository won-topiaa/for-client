/**
 * TikTok Lite 포인트 파머 — 코어 엔진
 * ------------------------------------------------------------------
 * 자동화 흐름 + 오류 복구 + 무한 파밍 루프 + 좌표 캘리브레이션.
 * UI(main.js)에서 engine.start()/stop(), calibrate() 를 호출합니다.
 */
"use strict";

var C = require("./config.js");
function cfg() { return C.get(); }

var W = device.width;
var H = device.height;

// ── 로그 ─────────────────────────────────────────────────────
var LOG_PATH = "/sdcard/ttl_farmer.log";
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
  try { files.append(LOG_PATH, line + "\n"); } catch (e) {}
}

// ── 대기(사람처럼 약간의 랜덤, 중단 가능) ────────────────────
function jitter(ms) {
  if (!cfg().humanize) return ms;
  return Math.round(ms * (0.85 + Math.random() * 0.3));
}
function napChunked(ms, isRunning) {
  var end = Date.now() + ms;
  while (Date.now() < end) {
    if (isRunning && !isRunning()) return;
    sleep(Math.min(500, end - Date.now()));
  }
}

// ── 저수준 탭/탐색 ───────────────────────────────────────────
function tapRatio(ratio, label) {
  var x = Math.round(ratio.x * W), y = Math.round(ratio.y * H);
  log((label || "탭") + " → (" + x + ", " + y + ")");
  click(x, y);
  sleep(jitter(cfg().timing.shortWait));
}
function clickNode(node) {
  if (node.click()) return true;
  var b = node.bounds();
  click(b.centerX(), b.centerY());
  return true;
}
function tapText(list, label, timeoutMs) {
  var t0 = (timeoutMs === undefined) ? cfg().retry.findTimeoutMs : timeoutMs;
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    var node = text(t).findOne(t0) || textContains(t).findOne(300) || desc(t).findOne(300);
    if (node) {
      log((label || "텍스트") + " '" + t + "' 클릭");
      clickNode(node);
      sleep(jitter(cfg().timing.shortWait));
      return true;
    }
    t0 = 300; // 첫 후보만 길게 대기
  }
  return false;
}
function tapTextOrCoord(list, coord, label) {
  if (list && tapText(list, label)) return true;
  if (coord) { tapRatio(coord, label + "(좌표)"); return true; }
  log(label + " 실패: 대상 못 찾음");
  return false;
}
function closePopup(label) {
  if (tapText(cfg().texts.close, (label || "팝업") + " 닫기")) {
    sleep(jitter(cfg().timing.afterPopupClose)); return true;
  }
  tapRatio(cfg().coords.popupClose, (label || "팝업") + " X버튼");
  sleep(jitter(cfg().timing.afterPopupClose)); return true;
}
function checkAndClosePopup() {
  // 시청 중 팝업: 오탭 방지를 위해 텍스트로만 닫음
  if (tapText(cfg().texts.close, "시청중 팝업", 300)) {
    sleep(jitter(cfg().timing.afterPopupClose)); return true;
  }
  return false;
}
function swipeToNextVideo() {
  var x = Math.round(W * 0.5);
  swipe(x, Math.round(H * 0.75), x, Math.round(H * 0.25), 400);
  sleep(800);
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

// ── 단계별 동작 ──────────────────────────────────────────────
function stepHeart()        { tapRatio(cfg().coords.heart, "우측중간 하트"); }
function stepPointButton()  { tapRatio(cfg().coords.pointButton, "포인트 버튼"); }
function stepAttendance()   { tapTextOrCoord(cfg().texts.attendance, cfg().coords.attendanceCheck, "출석체크"); }
function stepCloseApp()     { log("앱 종료(홈으로)"); home(); sleep(cfg().timing.shortWait); }

function watchVideos(durationMs, isRunning) {
  log("영상 시청: " + Math.round(durationMs / 1000) + "초");
  var end = Date.now() + durationMs;
  while (Date.now() < end) {
    if (isRunning && !isRunning()) return;
    if (!ensureForeground(false)) { sleep(3000); continue; }
    napChunked(jitter(cfg().timing.scrollIntervalMs), isRunning);
    checkAndClosePopup();
    swipeToNextVideo();
  }
}

// 6~10: 포인트 적립(타이머 수령 → 광고 → p → 좋아요 수령 → 뒤로)
function claimCycle() {
  log("=== 적립 사이클 ===");
  tapTextOrCoord(cfg().texts.timer, cfg().coords.timer, "타이머"); // 6
  tapText(cfg().texts.receive, "받기");
  if (!tapText(cfg().texts.watchAd, "광고보기")) {               // 7
    log("광고보기 없음 → 스킵"); return;
  }
  log("광고 30초 대기...");
  sleep(cfg().timing.afterAdWatch);                              // 8
  tapRatio(cfg().coords.topLeftP, "좌측상단 p");
  tapRatio(cfg().coords.videoLike, "영상 좋아요");               // 9
  sleep(jitter(cfg().timing.shortWait));
  tapText(cfg().texts.receive, "받기");
  back();                                                        // 10
  sleep(jitter(cfg().timing.shortWait));
}

// ── 엔진(스레드) ─────────────────────────────────────────────
var running = false;
var worker = null;

function safe(name, fn) {
  try { fn(); }
  catch (e) { log("⚠ " + name + " 오류: " + e); try { ensureForeground(false); } catch (e2) {} }
}

function runOnce() {
  log("[모드] 한 바퀴 실행");
  safe("실행", function () { ensureForeground(true); });          // 1
  safe("팝업", function () { closePopup("출석/이벤트"); });       // 2
  safe("하트", stepHeart);                                        // 3a
  safe("시청", function () { watchVideos(cfg().timing.watchDurationMs, isRunningFlag); }); // 3b
  safe("포인트", stepPointButton);                                // 4
  safe("팝업", function () { closePopup("포인트/이벤트"); });     // 5
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
  keepAwake();
  safe("실행", function () { ensureForeground(true); });
  safe("팝업", function () { closePopup("출석/이벤트"); });
  safe("하트", stepHeart);
  var lastAtt = 0;
  while (running) {
    if (!ensureForeground(false)) { sleep(3000); continue; }
    safe("포인트진입", stepPointButton);
    safe("팝업", function () { closePopup("포인트/이벤트"); });
    safe("적립", claimCycle);
    if (Date.now() - lastAtt > cfg().timing.dailyAttendanceMs) {
      safe("출석", stepAttendance); lastAtt = Date.now();
    }
    // 다음 타이머까지 영상 시청하며 대기(타이머가 시청으로 충전됨)
    safe("시청대기", function () { watchVideos(cfg().timing.betweenCycleMs, isRunningFlag); });
  }
  log("파밍 정지");
}

function isRunningFlag() { return running; }

function start() {
  if (running) { log("이미 실행 중"); return; }
  running = true;
  log("▶ 시작 (" + cfg().mode + ")");
  worker = threads.start(function () {
    try { (cfg().mode === "once") ? runOnce() : runFarm(); }
    catch (e) { log("치명적 오류: " + e); }
    running = false;
    log("■ 종료됨");
  });
}
function stop() {
  if (!running) return;
  running = false;
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
    log("좌표설정 시작 — 안내대로 각 위치를 탭하세요");
    for (var i = 0; i < CAL_TARGETS.length; i++) {
      var key = CAL_TARGETS[i][0], label = CAL_TARGETS[i][1];
      var pt = captureOneTap("[" + (i + 1) + "/" + CAL_TARGETS.length + "] " + label + " 를 탭하세요");
      if (!pt) { toast("좌표설정 취소"); log("좌표설정 취소"); return; }
      cfg().coords[key] = { x: pt.x / W, y: pt.y / H };
      C.save();
      log("저장: " + key + " = " + cfg().coords[key].x.toFixed(3) + ", " + cfg().coords[key].y.toFixed(3));
      sleep(400);
    }
    toast("좌표설정 완료!");
    log("좌표설정 완료");
  });
}
// 전체화면 오버레이로 한 번의 탭 좌표를 잡음
function captureOneTap(msg) {
  var result = { pt: null, done: false };
  ui.run(function () {
    var win = floaty.rawWindow(
      <frame w="*" h="*" bg="#88000000">
        <text text={msg} textColor="#ffffff" textSize="16sp" gravity="center" padding="24"/>
      </frame>
    );
    win.setSize(-1, -1);
    win.setTouchable(true);
    win.getRootView().setOnTouchListener(function (v, ev) {
      if (ev.getAction() === ev.ACTION_DOWN) {
        result.pt = { x: Math.round(ev.getRawX()), y: Math.round(ev.getRawY()) };
        try { win.close(); } catch (e) {}
        result.done = true;
      }
      return true;
    });
  });
  var t0 = Date.now();
  while (!result.done && Date.now() - t0 < 30000) sleep(100); // 최대 30초 대기
  return result.pt;
}

module.exports = {
  setLogSink: setLogSink,
  start: start, stop: stop, isRunning: isRunning,
  calibrate: calibrate,
  log: log,
};
