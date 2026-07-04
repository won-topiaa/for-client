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
// exact=true 이면 완전일치만(부분일치 금지) — "탭하여 포인트 받기" 같은
// 게임 진입 버튼을 "포인트 받기"로 오인식하는 것을 방지
function findAny(list, timeoutMs, exact) {
  if (!list || !list.length) return null;
  // 인자 방어: 숫자가 아니거나 음수/NaN이면 0으로 → for(;;)가 절대 무한루프 못 함
  var t = (typeof timeoutMs === "number" && isFinite(timeoutMs) && timeoutMs > 0) ? timeoutMs : 0;
  var end = Date.now() + t;
  for (;;) {
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      try {
        var n = text(s).findOnce() || desc(s).findOnce()
             || (!exact && s.length > 2 ? textContains(s).findOnce() : null);
        if (n) return { node: n, matched: s };
      } catch (e) { /* 접근성 노드 조회 순간 오류는 무시하고 재시도 */ }
    }
    if (Date.now() >= end) return null;      // NaN 불가 → 반드시 종료
    sleep(Math.min(250, end - Date.now()));
  }
}
function clickNode(node) {
  try {
    if (node.click()) return true;
    var b = node.bounds();
    if (b) { click(b.centerX(), b.centerY()); return true; }
  } catch (e) { log("클릭 실패: " + e); }
  return false;
}
function tapText(list, label, timeoutMs, exact) {
  var f = findAny(list, timeoutMs === undefined ? cfg().retry.findTimeoutMs : timeoutMs, exact);
  if (!f) return false;
  log((label || "텍스트") + " '" + f.matched + "' 클릭");
  var ok = clickNode(f.node);
  sleep(jitter(cfg().timing.shortWait));
  return ok;
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
  var gap = cfg().popup.roundGapMs;
  var maxClicks = Math.min(6, cfg().popup.maxRounds); // 총 닫기 클릭 상한(핑퐁 방지)
  var recent = []; // 최근 클릭한 닫기 텍스트(핑퐁 A,B,A,B 감지용)
  for (var c = 0; c < maxClicks; c++) {
    if (detectCaptcha()) return false;
    // ★ 이미 리워드 페이지가 보이면 더 이상 닫지 않음
    //   (페이지 내용의 확인/닫기 오클릭 + 핑퐁 무한반복 방지)
    if (findAny(cfg().texts.pageMarker, 200)) return true;
    // 1) 텍스트/desc 닫기
    var f = findAny(cfg().texts.close, 400);
    if (f) {
      log((label || "팝업") + " 닫기 '" + f.matched + "'");
      clickNode(f.node); sleep(gap);
      recent.push(f.matched); if (recent.length > 4) recent.shift();
      // ★ 핑퐁 감지: 최근 4클릭이 A,B,A,B(두 텍스트 번갈아) → 뒤로가기 탈출
      if (recent.length === 4 && recent[0] === recent[2] &&
          recent[1] === recent[3] && recent[0] !== recent[1]) {
        log("팝업 핑퐁 감지('" + recent[2] + "'↔'" + recent[3] + "') → 뒤로가기 탈출");
        back(); sleep(800); return true;
      }
      continue;
    }
    // 2) 닫기 텍스트 없음 + 리워드 페이지 아님 + 모달 이벤트 팝업만 → 좌표 ✕
    var eventOnly = !findAny(cfg().texts.pageMarker, 150) && !!findAny(cfg().texts.eventPopup, 200);
    if (eventOnly) {
      var spots = cfg().coords.eventCloseSpots || [];
      var closed = false;
      for (var s = 0; s < spots.length; s++) {
        tapRatio(spots[s], "이벤트팝업 ✕후보" + (s + 1));
        sleep(gap);
        if (detectCaptcha()) return false;
        if (!findAny(cfg().texts.eventPopup, 300)) { closed = true; break; }
      }
      if (!closed) { back(); sleep(600); }
      continue;
    }
    break; // 더 닫을 것 없음
  }
  return true;
}

// 하단 스티키 배너(야시장 챌린지 등)를 감지됐을 때만 ✕로 닫음
function closeStickyBanner() {
  if (findAny(cfg().texts.banner, 250)) {
    tapRatio(cfg().coords.bannerClose, "스티키 배너 ✕");
    sleep(300);
  }
}
function checkAndClosePopup() {
  // 시청 중 팝업: 확실한 닫기/알림거부 문구만(리워드 수령 오탭 방지)
  if (detectCaptcha()) return false;
  if (tapText(cfg().texts.watchClose, "시청중 팝업", 300)) {
    sleep(jitter(cfg().timing.afterPopupClose)); return true;
  }
  return false;
}
// CAPTCHA/보안인증/이상행동 화면 감지 — 있으면 파밍을 안전 정지시킴
function detectCaptcha() {
  var f = findAny(cfg().texts.captcha, 0); // 1회 스캔(캡차는 화면에 계속 떠 있음) — 타이트 루프 최적화
  if (!f) return false;
  log("🛑 보안인증/CAPTCHA 감지('" + f.matched + "') → 자동화 정지. 사람이 직접 처리 필요");
  captchaHit = true;
  running = false; // 루프 즉시 종료
  try { device.vibrate(800); } catch (e) {}
  toast("보안인증 감지! 직접 인증 후 다시 시작하세요");
  return true;
}
function swipeToNextVideo() {
  // 매번 궤적/속도를 조금씩 다르게(탐지 완화) — 빠르게 다음 영상으로
  var x1 = Math.round(W * rnd(0.42, 0.58));
  var x2 = x1 + Math.round(rnd(-25, 25));
  var y1 = Math.round(H * rnd(0.70, 0.78));
  var y2 = Math.round(H * rnd(0.20, 0.28));
  swipe(x1, y1, x2, y2, Math.round(rnd(180, 320)));
  sleep(Math.round(rnd(300, 550)));
}

// ── 앱 상태/복구 ─────────────────────────────────────────────
function isOurApp(pkg) {
  if (!pkg) return false;
  var c = cfg().packageCandidates || [];
  for (var i = 0; i < c.length; i++) if (pkg === c[i]) return true;
  // 부분매칭(지역/버전 변종): 패키지에 'tiktok.lite' 등이 포함되면 우리 앱으로 인정
  var f = cfg().packageFragments || [];
  for (var j = 0; j < f.length; j++) if (pkg.indexOf(f[j]) >= 0) return true;
  return false;
}
var lastLaunchAt = 0;
function launchApp(force) {
  // 재실행 쓰래싱 방지: 최근에 실행했으면 스킵(강제 force 제외)
  if (!force && Date.now() - lastLaunchAt < 8000) return;
  lastLaunchAt = Date.now();
  try {
    if (!app.launchApp(cfg().appName)) {
      var c = cfg().packageCandidates || [];
      for (var i = 0; i < c.length; i++) if (app.launchPackage(c[i])) break;
    }
  } catch (e) { log("앱 실행 오류: " + e); }
  sleep(cfg().timing.afterLaunch);
}
function ensureForeground(forceLaunch) {
  if (forceLaunch) { launchApp(true); }
  var pkg = currentPackage();
  if (isOurApp(pkg)) return true;
  log("포그라운드 아님(" + pkg + ") → 재실행");
  launchApp(false);
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

// 문자열이 '게임 카드' 문구인지(원판/슈팅마블/돼지저금통/럭키스핀 등)
function isGameText(s) {
  if (!s) return false;
  var g = cfg().texts.gameTitle || [];
  for (var i = 0; i < g.length; i++) if (s.indexOf(g[i]) >= 0) return true;
  var b = cfg().texts.gameButton || [];
  for (var j = 0; j < b.length; j++) if (s === b[j]) return true; // 버튼은 완전일치만
  return false;
}
// 현재 화면에 게임 카드가 보이면 true(= 스크롤이 하단 게임 구역에 닿음 → 멈춤 신호)
function atGameZone() { return !!findAny(cfg().texts.gameTitle, 150); }

// 제목 노드가 속한 '카드'의 버튼을 누름.
// 같은 행(비슷한 Y, 제목보다 오른쪽)에서 btnList 텍스트 버튼을 찾아 누르고,
// 없으면 제목 우측 좌표를 누름(카드 버튼은 대개 우측에 있음).
// → "시청/시작하기"가 여러 카드에 있어도 '이 카드의' 버튼만 정확히 누름
function tapCardButton(titleNode, btnList, label) {
  try {
    // ★ 게임 카드면 절대 손대지 않음(제목 문구로 판별)
    var ttext = "";
    try { ttext = String(titleNode.text() || titleNode.desc() || ""); } catch (e) {}
    if (isGameText(ttext)) { log("게임 카드 감지('" + ttext + "') → 탭 안 함"); return false; }

    var tb = titleNode.bounds();
    if (!tb) return false;
    var rowTol = Math.max(tb.height() * 3, 240);
    for (var i = 0; btnList && i < btnList.length; i++) {
      if (isGameText(btnList[i])) continue; // 게임 버튼 문구는 건너뜀(방어)
      var col = text(btnList[i]).find();
      try {
        for (var j = 0; col && j < col.size(); j++) {
          var n = col.get(j), b = n.bounds();
          if (b && Math.abs(b.centerY() - tb.centerY()) < rowTol && b.centerX() > tb.centerX()) {
            log(label + " '" + btnList[i] + "' 클릭");
            if (clickNode(n)) { sleep(jitter(cfg().timing.shortWait)); return true; }
          }
        }
      } finally { try { col.recycle(); } catch (e) {} }
    }
    var x = Math.round(W * 0.80), y = tb.centerY();
    log(label + " 우측버튼(좌표) → (" + x + ", " + y + ")");
    click(x, y); sleep(jitter(cfg().timing.shortWait)); return true;
  } catch (e) {
    log(label + " 카드버튼 탭 실패: " + e); return false;
  }
}

// 스크롤하며 특정 제목 카드를 찾음(찾으면 {node,matched}, 없으면 null)
// ★ 하단 게임 구역에 닿으면 즉시 중단(게임 화면 진입 사고 방지)
function findCard(titleList, maxScroll) {
  var m = (maxScroll === undefined) ? 6 : maxScroll;
  for (var s = 0; s <= m && running; s++) {
    var c = findAny(titleList, 700);
    if (c) return c;
    if (atGameZone()) { log("게임 구역 도달 → 카드 탐색 중단(안전)"); return null; }
    scrollRewardsDown();
  }
  return null;
}

// 리워드 페이지에 있는지 확인. 없으면 하단 "포인트" 탭(텍스트→좌표)으로 진입(최대 3회)
// ★ 핵심 수정: 페이지 표식은 '상단'에만 있어, 아래로 스크롤된 상태면 표식이 안 보여
//   '페이지 밖'으로 오판하던 버그가 있었음(하단 게임 구역에서 헤맴). 그래서
//   판정 전에 항상 맨 위로 올려 확인한다. 게임 카드가 보이면 = 페이지 안에 있는 것.
function onRewardsPageNow() {
  if (findAny(cfg().texts.pageMarker, 400)) return true;
  if (atGameZone()) return true; // 하단 게임 구역이 보임 = 리워드 페이지 맞음(스크롤됨)
  scrollRewardsTop();            // 스크롤 때문에 표식이 안 보였을 수 있음 → 위로 올려 재확인
  return !!findAny(cfg().texts.pageMarker, 500);
}
function ensureOnRewardsPage() {
  for (var i = 1; i <= 3; i++) {
    // 덮고 있는 팝업부터 닫고 표식 확인 → 이미 페이지면 탭을 다시 안 눌러
    // 팝업이 재생성되는 걸 막음(추가 리워드 반복 원인 제거)
    clearAllPopups("진입 팝업");
    closeStickyBanner();
    if (onRewardsPageNow()) return true;   // 스크롤 위치 무관하게 페이지 판정
    // 정말 페이지 밖 → 포인트 탭으로 진입(텍스트 우선, 실패 시 좌표)
    if (!tapText(cfg().texts.pointsTab, "포인트 탭", 700)) {
      tapRatio(cfg().coords.pointButton, "포인트 탭(좌표)");
    }
    clearAllPopups("진입 팝업");
    if (onRewardsPageNow()) { log("리워드 페이지 확인됨"); return true; }
    // 그래도 아니면 계획 밖 화면 → 뒤로가기(마지막 수단)
    log("계획 밖 화면 → 뒤로가기 탈출 " + i + "/3");
    back(); sleep(500);
  }
  log("⚠ 리워드 페이지 진입 실패");
  return false;
}

// 버튼 위치 기반 키(같은 자리 버튼 중복 클릭 방지용)
function nodeKey(f) {
  try {
    var b = f.node.bounds();
    return f.matched + "@" + Math.round(b.centerX() / 20) + "," + Math.round(b.centerY() / 20);
  } catch (e) { return f.matched; }
}

// 리워드 팝업 처리: (하단 '광고보기' 있으면 그 광고도 시청) → 확인/받기로 닫기.
// 같은 위치 버튼이 다시 잡히면(안 닫힘) 즉시 탈출 → 무한클릭 방지
function collectPopup() {
  var seen = {}, adTried = false;
  for (var i = 0; i < 6; i++) {
    if (detectCaptcha()) return;
    // 1) 팝업 하단 '광고 보기'(추가 보상) — 한 번만
    if (!adTried) {
      var fa = findAny(cfg().texts.popupAd, 400);
      if (fa) {
        adTried = true;
        log("팝업 광고보기 '" + fa.matched + "'");
        clickNode(fa.node); sleep(cfg().timing.afterTapReward);
        if (closeAd()) { stat.cycles++; log("팝업 보너스 광고 완료"); }
        sleep(cfg().timing.afterPopupClose); continue;
      }
    }
    // 2) 확인 우선(닫기) → 없으면 받기
    var f = findAny(cfg().texts.confirm, 350, true) || findAny(cfg().texts.receive, 350, true);
    if (!f) break;
    var k = nodeKey(f);
    if (seen[k]) break; // 같은 자리 버튼 재출현 = 안 닫힘 → 탈출
    seen[k] = 1;
    log("팝업 처리 '" + f.matched + "'");
    clickNode(f.node); sleep(cfg().timing.afterPopupClose);
  }
}

// 광고 화면인지 확인(상단 "15초 시청하고 30포인트 받기")
function inAdScreen() {
  return !!findAny(cfg().texts.adMarker, 500);
}

// 광고를 시청하고 X로 닫기만 함(팝업 수령은 하지 않음 → collectPopup과 상호재귀 방지)
// 주의: 광고 안의 "지금 쇼핑하기/다운로드" 등은 절대 누르지 않음(알려진 X만 누름)
function closeAd() {
  if (!inAdScreen()) {
    log("광고 화면 미진입(소진/쿨다운) → 스킵");
    return false;
  }
  log("광고 시청 " + Math.round(cfg().timing.adBaseWaitMs / 1000) + "초 대기...");
  napChunked(cfg().timing.adBaseWaitMs, isRunningFlag);
  var end = Date.now() + cfg().timing.adExtraWaitMs;
  while (Date.now() < end && running) {
    if (detectCaptcha()) return false;
    if (findAny(cfg().texts.pageMarker, 400)) { log("광고 종료(페이지 복귀)"); break; }
    tapRatio(cfg().coords.adClose, "광고 X(우상단)");
    sleep(900);
    if (!inAdScreen()) { back(); sleep(500); } // X 눌렀는데 랜딩페이지로 갔으면 뒤로
  }
  return true;
}

// 광고 시청 후 리워드 수령 팝업까지 처리
function watchAdThenClose() {
  if (!closeAd()) return false;
  collectPopup();
  return true;
}

// 리워드 페이지 스크롤 — 빠르게(스와이프 짧고, 대기 최소)
function scrollRewardsUp()   { swipe(Math.round(W*0.5), Math.round(H*0.35), Math.round(W*0.5), Math.round(H*0.75), 220); sleep(320); }
function scrollRewardsDown() { swipe(Math.round(W*0.5), Math.round(H*0.72), Math.round(W*0.5), Math.round(H*0.30), 220); sleep(320); }
function scrollRewardsTop()  { for (var i=0;i<3;i++) scrollRewardsUp(); }

// 스크롤 내리며 '포인트 받기'만 수확. 매 패스 반드시 한 칸 스크롤(진행 보장),
// 같은 위치 버튼 중복 클릭 차단, 4번 연속 못 찾으면 바닥으로 보고 종료.
function harvestClaimSweep() {
  scrollRewardsTop();
  var seen = {}, noFind = 0;
  for (var pass = 0; pass < 16 && running; pass++) {
    if (Date.now() > harvestDeadline) { log("수확 시간 초과"); break; }
    if (detectCaptcha()) return;
    checkAndClosePopup();   // 덮은 팝업만 텍스트로 빠르게(재진입 안 함 → 팝업 반복 방지)
    closeStickyBanner();
    var f = findAny(cfg().texts.pageClaim, 400, true); // "포인트 받기"만
    if (f && !seen[nodeKey(f)]) {
      seen[nodeKey(f)] = 1;
      log("리워드 수령 '" + f.matched + "'");
      clickNode(f.node); sleep(cfg().timing.afterTapReward);
      collectPopup(); stat.cycles++;
      noFind = 0;
    } else {
      if (++noFind >= 4) { log("더 받을 것 없음 — 스윕 종료"); break; }
    }
    // ★ 하단 게임 구역이 보이면 여기서 멈춤(게임 화면 진입/헤맴 방지)
    if (atGameZone()) { log("게임 구역 도달 → 스윕 종료(안전)"); break; }
    scrollRewardsDown(); // 항상 한 칸 내려감
  }
  scrollRewardsTop(); // ★ 끝나면 맨 위로 복귀(하단 게임 구역에 화면이 머물지 않게)
}

// 리워드 페이지 수확 — 사용자 지정 우선순위대로:
//   (선택)출석 → ①타이머(20분마다,최대40) → ②광고 보면 추가 보상(4)
//   → ③'포인트 받기' 스윕(좋아요 미션20 등) → ④매일 광고(최대200) → ⑤라이브 영상(60)
// 게시/검색/보류/친구초대/게임(캔디병·킥오프·스핀·원판)은 절대 안 함.
function harvestRewards(doAttendance) {
  if (!ensureOnRewardsPage()) return;
  harvestDeadline = Date.now() + (cfg().timing.harvestBudgetMs || 480000);
  clearAllPopups("초기 팝업");
  closeStickyBanner();

  // (선택) 출석하기 — 기본 마지막에 별도 수행. 여기선 doAttendance=true일 때만.
  if (doAttendance && running && tapText(cfg().texts.attendance, "출석하기", 1500, true)) {
    sleep(cfg().timing.afterTapReward);
    collectPopup(); stat.cycles++;
    ensureOnRewardsPage(); closeStickyBanner();
  }

  // ① 타이머(20분마다, 최대 40) — 시작하자마자 이미 충전돼 있으면 바로 수령
  if (running) {
    scrollRewardsTop();
    var tc = findCard(cfg().texts.timerTitle, 4);
    if (tc) {
      if (tapCardButton(tc.node, cfg().texts.pageClaim, "타이머 받기")) {
        sleep(cfg().timing.afterTapReward); collectPopup(); stat.cycles++;
      }
      ensureOnRewardsPage(); closeStickyBanner();
    }
  }

  // ② 광고 보면 추가 보상(4) — 쿨다운 끝났을 때만 실제 광고가 열림
  if (running) claimAdBonus();
  if (!running) return;

  // ③ '포인트 받기' 스윕 — 좋아요 미션(20) 등 페이지에 이미 준비된 수령을 훑음.
  //    (좋아요 미션은 영상 1개 좋아요 후에야 활성화되므로, 첫 영상 시청 뒤 수확부터 잡힘)
  //    매 패스 무조건 한 칸 스크롤(진행 보장), 같은 위치 중복 클릭 차단.
  if (running) harvestClaimSweep();

  // ④ 매일 광고(하루 40개, 최대 ~200) — 사이클당 batch개
  if (running) watchDailyAdBatch();

  // ⑤ 라이브 영상 시청(하루 10회, 최대 60) — 사이클당 liveBatch개
  if (running) watchLiveBatch();
}

// '광고 보면 추가 보상' 카드를 찾아 광고를 1회 시청 후 닫음
function claimAdBonus() {
  ensureOnRewardsPage(); scrollRewardsTop();
  var adCard = findCard(cfg().texts.adRewardTitle, 6);
  if (!adCard) return;
  tapCardButton(adCard.node, null, "광고 추가보상"); // 카드 우측(>) 탭
  sleep(cfg().timing.afterTapReward);
  if (detectCaptcha()) return;
  if (inAdScreen()) { if (closeAd()) stat.cycles++; collectPopup(); }
  else log("광고 추가보상 쿨다운/미준비 → 스킵");
  ensureOnRewardsPage(); closeStickyBanner();
}

// '매일 광고' 카드를 찾아 그 카드의 '시청' 버튼만 눌러 광고를 batch개 시청
function watchDailyAdBatch() {
  var batch = cfg().dailyAdBatch || 0;
  if (batch <= 0) return;
  log("매일 광고 시청 시작(최대 " + batch + "개)");
  for (var i = 0; i < batch && running; i++) {
    if (Date.now() > harvestDeadline) { log("수확 시간 초과 → 매일광고 종료"); break; }
    if (!ensureOnRewardsPage()) break;
    closeStickyBanner(); scrollRewardsTop();
    var card = findCard(cfg().texts.dailyAdCard, 6);
    if (!card) { log("매일 광고 카드 없음 → 종료"); break; }
    tapCardButton(card.node, cfg().texts.watchBtn, "매일광고 '시청'");
    sleep(cfg().timing.afterTapReward);
    if (detectCaptcha()) return;
    if (!inAdScreen()) { log("광고 안 열림(한도 소진/쿨다운) → 매일광고 종료"); break; }
    if (closeAd()) { stat.cycles++; log("매일 광고 " + (i + 1) + "개째 완료"); }
    collectPopup();
  }
  if (ensureOnRewardsPage()) scrollRewardsTop();
}

// '라이브 영상 시청' 카드를 찾아 '시청'을 눌러 라이브를 batch회 시청.
// ※ 실기기 테스트가 어려워 방어적으로 구현: 라이브가 열리지 않거나(쿨다운/한도)
//    UI가 다르면 즉시 스킵하고 리워드 페이지로 복귀(오작동 방지).
function watchLiveBatch() {
  var batch = cfg().liveBatch || 0;
  if (batch <= 0) return;
  log("라이브 영상 시청 시작(최대 " + batch + "회)");
  for (var i = 0; i < batch && running; i++) {
    if (Date.now() > harvestDeadline) { log("수확 시간 초과 → 라이브 종료"); break; }
    if (!ensureOnRewardsPage()) break;
    closeStickyBanner(); scrollRewardsTop();
    var card = findCard(cfg().texts.liveTitle, 8);
    if (!card) { log("라이브 카드 없음 → 종료"); break; }
    tapCardButton(card.node, cfg().texts.watchBtn, "라이브 '시청'");
    sleep(cfg().timing.afterTapReward);
    if (detectCaptcha()) return;
    // 리워드 페이지 표식이 그대로면 라이브가 안 열린 것(한도/쿨다운) → 종료
    if (findAny(cfg().texts.pageMarker, 300)) {
      log("라이브 안 열림(한도/쿨다운/UI상이) → 종료");
      ensureOnRewardsPage(); break;
    }
    // 라이브 시청(크레딧 위해 지정 시간 유지), 중간 팝업은 닫으며 대기
    var until = Date.now() + (cfg().timing.liveWatchMs || 40000);
    while (running && Date.now() < until) {
      checkAndClosePopup();
      napChunked(2000, isRunningFlag);
    }
    // 라이브에서 빠져나와 리워드 페이지로 복귀
    for (var b = 0; b < 4 && !findAny(cfg().texts.pageMarker, 300); b++) { back(); sleep(700); }
    collectPopup();
    // ※ 라이브 보상 지급 여부를 화면상 확실히 확인할 수 없어 적립 카운트는 올리지 않음
    //   (거짓 적립 표시 방지). 복귀만 확인하고 다음 회차 진행.
    if (!ensureOnRewardsPage()) break;
    log("라이브 " + (i + 1) + "회째 시청 완료(적립은 앱에서 확인)");
  }
  scrollRewardsTop();
}

// ── 엔진(스레드) ─────────────────────────────────────────────
var running = false;
var worker = null;
var harvestDeadline = 0; // 한 번의 수확 시간 상한(무한루프 backstop)

function safe(name, fn) {
  try { fn(); }
  catch (e) {
    stat.lastError = name + ": " + e;
    log("⚠ " + name + " 오류: " + e);
    // 정지(인터럽트)로 인한 예외면 복구 안 함 — 정지 후 앱 재실행/추가동작 방지
    if (running) { try { ensureForeground(false); } catch (e2) {} }
  }
}
function isRunningFlag() { return running; }

function runOnce() {
  log("[모드] 한 바퀴 수확");
  safe("실행", function () { ensureForeground(true); });
  safe("팝업", function () { clearAllPopups("초기 이벤트"); });
  safe("수확", function () { harvestRewards(true); });
  safe("종료", stepCloseApp);
  log("한 바퀴 완료");
}

// 영상 피드로 이동(리워드 페이지에서 빠져나옴)
function gotoFeed() {
  for (var i = 0; i < 3; i++) {
    if (!findAny(cfg().texts.pageMarker, 400)) return; // 이미 피드
    back(); sleep(700);
  }
}

// 피드를 지정 시간만큼 스크롤하며 시청(중간에 리워드 수확 타이밍이면 빠져나옴)
// + 주기적으로 "다음 리워드까지 N분" 로그로 살아있음을 표시
function scrollFeedUntil(untilMs) {
  var nextTick = 0;
  while (running && Date.now() < untilMs) {
    if (!ensureForeground(false)) { sleep(3000); continue; }
    checkAndClosePopup();
    swipeToNextVideo();
    if (Date.now() > nextTick) {
      var leftMin = Math.max(0, Math.ceil((untilMs - Date.now()) / 60000));
      log("영상 시청 중… 다음 리워드 수확까지 약 " + leftMin + "분");
      nextTick = Date.now() + 30000;
    }
    napChunked(jitter(cfg().timing.scrollIntervalMs), isRunningFlag);
  }
}

// 리워드 페이지에서 '출석하기'만 수행(마지막 단계용)
function doAttendanceOnly() {
  if (!ensureOnRewardsPage()) return;
  closeStickyBanner();
  if (tapText(cfg().texts.attendance, "출석하기", 1500, true)) {
    sleep(cfg().timing.afterTapReward);
    collectPopup(); stat.cycles++;
    log("출석체크 완료");
  } else {
    log("출석체크 버튼 없음(이미 했거나 오늘 없음)");
  }
}

// 최종 플로우: 진입 즉시 포인트 수확(이미 충전된 타이머부터) → 영상시청 청크와
//             수확을 번갈아 반복 → (시간 만료) 출석체크 → 앱 종료
function runFarm() {
  var total = cfg().timing.totalRunMs || (160 * 60 * 1000);
  log("[최종 플로우] 포인트 우선 수확 후 영상시청 반복 — 약 " + Math.round(total / 60000) + "분 후 출석·종료");

  safe("실행", function () { ensureForeground(true); });          // 1. TikTok Lite 실행
  safe("팝업", function () { clearAllPopups("영상화면 팝업"); }); // 2. 영상화면 팝업 종료

  // 3. 앱 진입 즉시 포인트 페이지로 가서 먼저 수확
  //    (①타이머 최대40 ②광고 추가보상4 ③준비된 포인트받기 스윕 ④매일광고 ⑤라이브)
  //    ※ 좋아요 미션(20)은 영상 1개 좋아요 후 활성화되므로 이 첫 수확엔 안 잡힐 수 있음
  safe("첫수확", function () { log("⏰ 진입 즉시 포인트 수확"); harvestRewards(false); });

  var end = Date.now() + total;
  // 4. 영상 시청(팝업 닫으며) + 20분마다 리워드 수확 반복
  while (running && Date.now() < end) {
    safe("피드시청", function () {
      gotoFeed();
      sleep(1500);
      tapRatio(cfg().coords.feedLike, "첫 영상 좋아요");          // 우측 하트/좋아요(미션 활성화)
      var until = Math.min(end, Date.now() + cfg().timing.betweenCycleMs);
      scrollFeedUntil(until);                                    // 팝업 닫으며 시청
    });
    if (!running || Date.now() >= end) break;
    // 리워드 수확(출석 제외): 포인트진입/팝업/타이머/광고/좋아요/매일광고/라이브/뒤로
    safe("수확", function () { log("⏰ 리워드 수확"); harvestRewards(false); });
  }

  // 시간이 만료되어 끝난 경우에만(사용자 정지가 아님) 마무리 단계 수행
  if (running) {
    safe("마지막수확", function () { log("⏰ 마지막 리워드 수확"); harvestRewards(false); }); // 남은 리워드
    safe("출석체크", doAttendanceOnly);  // 12. 출석체크(마지막)
    safe("앱종료", stepCloseApp);         // 13. 앱 종료
    log("✅ 최종 플로우 완료(약 " + Math.round(total / 60000) + "분)");
  } else {
    log("사용자 정지 — 마무리 단계 생략");
  }
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
