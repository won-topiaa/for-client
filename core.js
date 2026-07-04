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
  var end = Date.now() + timeoutMs;
  for (;;) {
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      try {
        var n = text(t).findOnce() || desc(t).findOnce()
             || (!exact && t.length > 2 ? textContains(t).findOnce() : null);
        if (n) return { node: n, matched: t };
      } catch (e) { /* 접근성 노드 조회 순간 오류는 무시하고 재시도 */ }
    }
    var remain = end - Date.now();
    if (remain <= 0) return null;
    sleep(Math.min(250, remain));
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
  var rounds = Math.min(10, cfg().popup.maxRounds); // 초기 이벤트가 10개+ 라 넉넉히
  var gap = cfg().popup.roundGapMs;
  var lastMatched = null, sameCount = 0;
  for (var round = 0; round < rounds; round++) {
    if (detectCaptcha()) return false;
    // 1) 안전한 텍스트/desc 닫기 — 단, 같은 팝업이 계속 재출현하면 탈출
    var f = findAny(cfg().texts.close, 500);
    if (f) {
      if (f.matched === lastMatched) sameCount++; else { sameCount = 0; lastMatched = f.matched; }
      if (sameCount >= 3) { // 같은 닫기 버튼이 계속 다시 뜸 = 무한반복 → 탈출
        log("팝업 재출현 감지('" + f.matched + "') → 뒤로가기로 탈출");
        back(); sleep(1000); break;
      }
      log((label || "팝업") + " 닫기 '" + f.matched + "'");
      clickNode(f.node); sleep(gap); continue;
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
      if (!closed) { back(); sleep(800); }
      continue;
    }
    // 3) 더 닫을 것 없음 → 종료(헤매지 않기)
    break;
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

// 제목 노드가 속한 '카드'의 버튼을 누름.
// 같은 행(비슷한 Y, 제목보다 오른쪽)에서 btnList 텍스트 버튼을 찾아 누르고,
// 없으면 제목 우측 좌표를 누름(카드 버튼은 대개 우측에 있음).
// → "시청/시작하기"가 여러 카드에 있어도 '이 카드의' 버튼만 정확히 누름
function tapCardButton(titleNode, btnList, label) {
  try {
    var tb = titleNode.bounds();
    if (!tb) return false;
    var rowTol = Math.max(tb.height() * 3, 240);
    for (var i = 0; btnList && i < btnList.length; i++) {
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
function findCard(titleList, maxScroll) {
  var m = (maxScroll === undefined) ? 6 : maxScroll;
  for (var s = 0; s <= m && running; s++) {
    var c = findAny(titleList, 700);
    if (c) return c;
    scrollRewardsDown();
  }
  return null;
}

// 리워드 페이지에 있는지 확인. 없으면 하단 "포인트" 탭(텍스트→좌표)으로 진입(최대 3회)
function ensureOnRewardsPage() {
  for (var i = 1; i <= 3; i++) {
    // 덮고 있는 팝업부터 닫고 표식 확인 → 이미 페이지면 탭을 다시 안 눌러
    // 팝업이 재생성되는 걸 막음(추가 리워드 반복 원인 제거)
    clearAllPopups("진입 팝업");
    closeStickyBanner();
    if (findAny(cfg().texts.pageMarker, 700)) return true;
    // 아직 페이지 아님 → 포인트 탭으로 진입
    if (!tapText(cfg().texts.pointsTab, "포인트 탭", 700)) {
      tapRatio(cfg().coords.pointButton, "포인트 탭(좌표)");
    }
    clearAllPopups("진입 팝업");
    if (findAny(cfg().texts.pageMarker, 1200)) { log("리워드 페이지 확인됨"); return true; }
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
      if (++noFind >= 4) { log("바닥 도달 — 더 받을 것 없음"); break; }
    }
    scrollRewardsDown(); // 항상 한 칸 내려감
  }
}

// 리워드 페이지 수확(순서): 출석 → 타이머(먼저) → 스크롤 스윕(포인트받기)
// → 광고 추가보상 → 매일광고 배치. 게시/검색/보류/친구초대/게임은 절대 안 함.
function harvestRewards(doAttendance) {
  if (!ensureOnRewardsPage()) return;
  harvestDeadline = Date.now() + (cfg().timing.harvestBudgetMs || 480000);
  clearAllPopups("초기 팝업");
  closeStickyBanner();

  // 1) 출석하기(하루 1회)
  if (doAttendance && running && tapText(cfg().texts.attendance, "출석하기", 1500, true)) {
    sleep(cfg().timing.afterTapReward);
    collectPopup(); stat.cycles++;
    ensureOnRewardsPage(); closeStickyBanner();
  }

  // 2) 타이머(20분마다) 먼저 — 카드 지정으로 그 카드의 '포인트 받기'만
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

  // 3) 스크롤 내리며 '포인트 받기' 수확 — 매 패스 무조건 한 칸 스크롤(진행 보장),
  //    같은 위치 중복 클릭 차단, 4번 연속 못 찾으면 바닥으로 보고 종료
  if (running) harvestClaimSweep();

  // 4) 광고 보면 추가 보상(쿨다운 끝났을 때만 실제로 광고가 열림) — 카드 지정
  if (running) {
    ensureOnRewardsPage(); scrollRewardsTop();
    var adCard = findCard(cfg().texts.adRewardTitle, 6);
    if (adCard) {
      tapCardButton(adCard.node, null, "광고 추가보상"); // 카드 우측(>) 탭
      sleep(cfg().timing.afterTapReward);
      if (detectCaptcha()) return;
      if (inAdScreen()) { if (closeAd()) stat.cycles++; collectPopup(); }
      else log("광고 추가보상 쿨다운/미준비 → 스킵");
      ensureOnRewardsPage(); closeStickyBanner();
    }
  }

  // 5) 매일 광고(하루 40개) — 사이클당 batch개
  if (running) watchDailyAdBatch();
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
  ensureOnRewardsPage();
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
    try { ensureForeground(false); } catch (e2) {}
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

// 최종 플로우: 영상시청 우선(지정 시간) + 20분마다 수확 → 출석체크 → 앱 종료
function runFarm() {
  var total = cfg().timing.totalRunMs || (160 * 60 * 1000);
  log("[최종 플로우] 영상시청 우선 파밍 — 약 " + Math.round(total / 60000) + "분 후 출석·종료");

  safe("실행", function () { ensureForeground(true); });          // 1. TikTok Lite 실행
  safe("팝업", function () { clearAllPopups("영상화면 팝업"); }); // 2. 영상화면 팝업 종료

  var end = Date.now() + total;
  // 3. 영상 시청(팝업 닫으며) + 20분마다 리워드 수확 반복
  while (running && Date.now() < end) {
    safe("피드시청", function () {
      gotoFeed();
      sleep(1500);
      tapRatio(cfg().coords.feedLike, "첫 영상 좋아요");          // 우측 하트/좋아요
      var until = Math.min(end, Date.now() + cfg().timing.betweenCycleMs);
      scrollFeedUntil(until);                                    // 팝업 닫으며 시청
    });
    if (!running || Date.now() >= end) break;
    // 4~11. 리워드 수확(출석 제외): 포인트진입/팝업/타이머/광고/좋아요/매일광고/뒤로
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
