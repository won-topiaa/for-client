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
  // 매번 궤적/속도를 조금씩 다르게(탐지 완화) — 빠르게 다음 영상으로.
  // ★ y2를 0.34H 아래로(예전 0.20H) → 상단 제어판을 지나지 않게 해 스와이프가 먹히지
  //   않는 문제 방지(리워드 페이지 스크롤과 동일한 이유).
  var x1 = Math.round(W * rnd(0.42, 0.58));
  var x2 = x1 + Math.round(rnd(-25, 25));
  var y1 = Math.round(H * rnd(0.74, 0.82));
  var y2 = Math.round(H * rnd(0.34, 0.42));
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
// 현재 화면에 게임 카드가 보이면 true(리워드 페이지 판정 시 '스크롤됨'으로 인정하는 용도)
function atGameZone() { return !!findAny(cfg().texts.gameTitle, 150); }

// 현재 화면(대상 앱)의 텍스트 지문 — 스크롤 후 이게 그대로면 '스크롤이 안 움직인 것'
// (바닥 도달/스크롤 불가) → 같은 화면에서 무한반복하는 것을 막는 데 사용
function screenSig() {
  try {
    var pkg = currentPackage();
    var col = className("android.widget.TextView").packageName(pkg).find();
    var parts = [];
    try {
      for (var i = 0; i < col.size() && parts.length < 5; i++) {
        var n = col.get(i);
        var t = null; try { t = n.text(); } catch (e) {}
        if (t && t.length) {
          var b = null; try { b = n.bounds(); } catch (e2) {}
          parts.push(t + "@" + (b ? b.top : 0));
        }
      }
    } finally { try { col.recycle(); } catch (e) {} }
    return parts.length ? parts.join("|") : null;
  } catch (e) { return null; }
}

// 제목 노드가 속한 '카드'의 버튼을 누름.
// 같은 행(비슷한 Y, 제목보다 오른쪽)에서 btnList 텍스트 버튼을 찾아 누르고,
// 없으면 제목 우측 좌표를 누름(카드 버튼은 대개 우측에 있음).
// → "시청/시작하기"가 여러 카드에 있어도 '이 카드의' 버튼만 정확히 누름
function tapCardButton(titleNode, btnList, label, noFallback) {
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
    // noFallback=true면 지정 버튼 텍스트가 없을 때 좌표 폴백을 하지 않음.
    //  (좋아요 카드처럼 버튼이 '미션 완료/시작하기'로 바뀌는 카드에서
    //   우측 좌표를 눌러 엉뚱한 걸 탭하는 사고 방지)
    if (noFallback) { log(label + " 지정 버튼 없음 → 스킵(폴백 안 함)"); return false; }
    var x = Math.round(W * 0.80), y = tb.centerY();
    log(label + " 우측버튼(좌표) → (" + x + ", " + y + ")");
    click(x, y); sleep(jitter(cfg().timing.shortWait)); return true;
  } catch (e) {
    log(label + " 카드버튼 탭 실패: " + e); return false;
  }
}

// 스크롤하며 특정 제목 카드를 찾음(찾으면 {node,matched}, 없으면 null)
// ※ 게임 카드가 보여도 '멈추지 않고' 그냥 지나쳐 계속 찾음(스크롤은 자유롭게).
//   게임을 건드리지 않는 안전장치는 tapCardButton의 '버튼 탭 차단'이 담당.
//   스크롤이 더 이상 움직이지 않으면(바닥) 조기 종료 → 헛도는 것 방지.
function findCard(titleList, maxScroll) {
  var m = (maxScroll === undefined) ? 6 : maxScroll;
  var lastSig = null, stuck = 0;
  for (var s = 0; s <= m && running; s++) {
    var c = findAny(titleList, 700);
    if (c) return c;
    scrollRewardsDown();
    var sig = screenSig();
    if (sig && sig === lastSig) { if (++stuck >= 2) return null; } // 2번 연속 안 움직임 = 바닥
    else stuck = 0;
    lastSig = sig;
  }
  return null;
}

// 리워드 페이지에 있는지 확인. 없으면 하단 "포인트" 탭(텍스트→좌표)으로 진입(최대 3회)
// ★ 핵심 수정: 페이지 표식은 '상단'에만 있어, 아래로 스크롤된 상태면 표식이 안 보여
//   '페이지 밖'으로 오판하던 버그가 있었음(하단 게임 구역에서 헤맴). 그래서
//   판정 전에 항상 맨 위로 올려 확인한다. 게임 카드가 보이면 = 페이지 안에 있는 것.
function onRewardsPageNow() {
  if (findAny(cfg().texts.pageMarker, 300)) return true;
  // 표식(상단 전용)이 안 보여도, 리워드 '콘텐츠'가 보이면 = 스크롤된 리워드 페이지.
  //   (게임 카드 / '포인트 받기' / '시청' 버튼 중 하나라도 보이면 페이지 안으로 인정)
  //   이때만 맨 위로 올려 표식을 재확인 → 피드/광고 화면에서 헛스크롤하지 않음.
  var t = cfg().texts;
  if (atGameZone() || findAny(t.pageClaim, 150) || findAny(t.watchBtn, 150) ||
      findAny(t.timerTitle, 150) || findAny(t.dailyAdCard, 150)) {
    if (scrollRewardsTop()) return true;
    return true; // 리워드 콘텐츠가 확실히 보였으니 페이지 안으로 간주(표식만 못 올라온 경우)
  }
  return false; // 리워드 콘텐츠가 전혀 안 보임 = 페이지 밖(피드/광고 등)
}
function ensureOnRewardsPage() {
  for (var i = 1; i <= 4; i++) {
    // 덮고 있는 팝업(광고 후 '광고 시청하고 추가 리워드[나중에 하기]' 등)부터 닫고 표식 확인
    clearAllPopups("진입 팝업");
    if (onRewardsPageNow()) return true;   // 스크롤 위치 무관하게 페이지 판정
    // ★ 화면 종류에 맞게 복귀:
    //   - 피드(하단 '포인트' 탭 보임) → 포인트 탭으로 리워드 진입
    //   - 그 외(광고 랜딩페이지 등, 포인트 탭 없음) → back으로 '언와인드'(광고 스택 탈출)
    //   예전엔 어디서든 포인트 탭(좌표)만 헛누르고 back 1회라, 광고 랜딩페이지가 여러 겹일 때
    //   못 빠져나와 '진입 실패'가 났음. 피드일 때만 탭, 아니면 back으로 확실히 벗겨낸다.
    if (findAny(cfg().texts.pointsTab, 250)) {
      if (!tapText(cfg().texts.pointsTab, "포인트 탭", 500)) {
        tapRatio(cfg().coords.pointButton, "포인트 탭(좌표)");
      }
    } else if (onStuckActivity()) {
      // 광고/랜딩(비접근성)에 갇힘 → 좌표 X/back으로 확실히 탈출(bailFromAdStack)
      log("광고/랜딩('" + curActivity() + "') 갇힘 → 스택 탈출 " + i + "/4");
      bailFromAdStack();
    } else if (isOurApp(currentPackage())) {
      // ★ 실기기(2026-07-06): TikTok Lite 피드가 캔버스(Lynx/GL)로 렌더돼 하단 '포인트'
      //   탭 '텍스트'가 접근성 트리에 전혀 안 잡힘(uiautomator 11노드·텍스트0). 그래서
      //   위 findAny(pointsTab)가 늘 실패 → 예전엔 좌표 폴백까지 건너뛰고 back만 눌러
      //   앱을 나가버렸음(마무리 수확 전멸). 우리 앱 안이고 스턱 액티비티도 아니면 =
      //   피드로 보고 '포인트' 탭을 좌표로 눌러 리워드 페이지(SparkActivity, 텍스트 잡힘)로 진입.
      log("피드(캔버스, 포인트 텍스트 미노출) → 포인트 탭 좌표로 진입 " + i + "/4");
      tapRatio(cfg().coords.pointButton, "포인트 탭(좌표)");
      sleep(cfg().timing.afterTapReward);
    } else {
      log("앱 밖(" + currentPackage() + ") → 뒤로가기 복귀 " + i + "/4");
      back(); sleep(700);
    }
    clearAllPopups("진입 팝업");
    if (onRewardsPageNow()) { log("리워드 페이지 확인됨"); return true; }
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
  // ★ 보상은 상단 카운트('N초 시청하고 …포인트 받기') 표식이 사라질 때 지급된다.
  //   실측: 30초 광고를 20초에 X로 닫으면 '무보상'으로 그냥 닫혔음(토스트 없음).
  //   → 최소 시청(adBaseWaitMs) 뒤, 표식이 사라질(=적립될) 때까지 기다린 후 닫는다.
  log("광고 시청 — 최소 " + Math.round(cfg().timing.adBaseWaitMs / 1000) + "초 + 적립(표식 소멸) 대기...");
  napChunked(cfg().timing.adBaseWaitMs, isRunningFlag);
  var creditBy = Date.now() + cfg().timing.adExtraWaitMs;
  while (running && Date.now() < creditBy) {
    if (detectCaptcha()) return false;
    if (!inAdScreen()) break;                          // 카운트 표식 사라짐 = 적립 완료
    if (findAny(cfg().texts.pageMarker, 200)) break;   // 이미 페이지로 복귀
    sleep(1000);
  }
  // 적립됨(표식 소멸) → 광고/랜딩 스택에서 확실히 탈출.
  //  (리워드광고 upsell 팝업은 좌표 X로, Spark 랜딩은 back으로 — bailFromAdStack이 처리)
  bailFromAdStack();
  return true;
}

// 리워드 페이지 스크롤 — 드래그로 확실히(350ms).
// ★ 중요: 스와이프 y-범위를 화면 상단 '제어판(플로팅 창)' 아래(약 y>0.30H)로 제한한다.
//   제어판이 기본 좌상단(≈y 200~640px)을 덮는데, 예전엔 스와이프가 y=0.20H(≈528px)까지
//   올라가 제어판 위를 지나면서 '터치 가능 오버레이'가 제스처를 가로채 스크롤이 먹히지
//   않던 문제가 있었음. 양 끝점을 0.31H↔0.85H로 잡아 제어판을 피한다.
function scrollRewardsUp()   { swipe(Math.round(W*0.5), Math.round(H*0.31), Math.round(W*0.5), Math.round(H*0.85), 350); sleep(350); }
function scrollRewardsDown() { swipe(Math.round(W*0.5), Math.round(H*0.85), Math.round(W*0.5), Math.round(H*0.31), 350); sleep(350); }
// ★ 핵심 수정: '맨 위'는 고정 횟수가 아니라 상단 표식이 보일 때까지(또는 더 이상
//   안 올라갈 때까지) 반복해서 올린다. 긴 페이지에서 위로 못 돌아오던 버그의 해결.
function scrollRewardsTop() {
  var last = null;
  for (var i = 0; i < 14 && running; i++) {
    if (findAny(cfg().texts.pageMarker, 150)) return true; // 최상단 도달
    scrollRewardsUp();
    var sig = screenSig();
    if (sig && sig === last) break; // 더 이상 안 올라감(최상단 or 스크롤 막힘)
    last = sig;
  }
  return !!findAny(cfg().texts.pageMarker, 150);
}

// 스크롤 내리며 '포인트 받기'만 수확. 매 패스 반드시 한 칸 스크롤(진행 보장),
// 같은 위치 버튼 중복 클릭 차단, 4번 연속 못 찾으면 바닥으로 보고 종료.
function harvestClaimSweep() {
  scrollRewardsTop();
  var seen = {}, noFind = 0, stuck = 0;
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
    // 스크롤이 더 이상 안 움직이면(바닥) 종료 — 같은 화면 무한반복 방지
    var before = screenSig();
    scrollRewardsDown(); // 항상 한 칸 내려감
    if (before && before === screenSig()) {
      if (++stuck >= 2) { log("바닥 도달(스크롤 정지) — 스윕 종료"); break; }
    } else { stuck = 0; }
  }
  scrollRewardsTop(); // 끝나면 맨 위로 복귀(하단에 화면이 머물지 않게)
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
  //  ※ exact=false(부분매칭): "오늘 출석하고 200 받기"처럼 N이 달라 정확일치 불가.
  //    "오늘 출석하고"만 매칭하므로 회색 '내일 출석하고…'는 안 눌러 중복지급/오탭 없음.
  if (doAttendance && running && tapText(cfg().texts.attendance, "출석", 1500, false)) {
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
  // maxScroll=3: 이 카드가 있으면 대개 상단 근처. 없는 UI(복귀 프로모 등)에서
  //   매 사이클 헛스크롤을 줄여 전체 수확 플로우를 빠르게 유지.
  var adCard = findCard(cfg().texts.adRewardTitle, 3);
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

// '라이브 영상 시청' 카드 → 라이브 진입 → 시청 → '리워드 포인트 수령'만 안전 수령 → 복귀.
// ★★ 절대 금지: 선물 보내기('보내기'/'선물 보내기'/'선물 보내고 …[보내기]')·선물 아이콘.
//    포인트/현금 소모 위험 → 코드는 '수령/리워드 포인트 수령/시청/포인트'만 텍스트로 누르고,
//    수령 후 뜨는 선물 유도 팝업은 back으로만 닫는다. 선물 좌표는 절대 안 누름.
// 실측(2026-07): 라이브 보상은 '시청'만으론 지급 안 됨. 시청 후 좌상단 '수령' 필 →
//    시트의 '리워드 포인트 수령'을 눌러야 회당 ~4~6P 적립(카운터 0→2 확인).
//    라이브를 나가면 '피드'로 나오므로 '포인트' 탭으로 리워드 페이지 복귀.
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
    // 라이브 시청(크레딧 누적). ★ 이 동안엔 아무 것도 탭하지 않는다
    //   (라이브 X/선물 오탭 방지 — checkAndClosePopup은 '×'를 눌러 라이브를 닫을 수 있어 제외)
    var until = Date.now() + (cfg().timing.liveWatchMs || 40000);
    while (running && Date.now() < until) {
      if (detectCaptcha()) return;
      napChunked(2000, isRunningFlag);
    }
    // 준비된 포인트만 안전 수령(선물 팝업은 back으로 닫음)
    claimLiveReadyPoints();
    // 라이브 나가기 → 피드 → '포인트' 탭으로 리워드 페이지 복귀(앱 종료 방지)
    exitLiveToRewards();
    if (!ensureOnRewardsPage()) break;
    log("라이브 " + (i + 1) + "회째 완료");
  }
  scrollRewardsTop();
}

// 라이브 시청 후 '리워드 포인트 수령'으로 준비된 포인트만 텍스트로 안전 수령.
// ★ 선물 관련(보내기/선물 아이콘)은 절대 누르지 않는다.
function claimLiveReadyPoints() {
  // 좌상단 '수령' 필이 있으면 눌러 리워드 시트 열기(정확일치 — '리워드 포인트 수령'과 구분)
  tapText(cfg().texts.liveCollect, "라이브 '수령'필", 1200, true);
  sleep(700);
  for (var k = 0; k < 6 && running; k++) {
    if (detectCaptcha()) return;
    // '리워드 포인트 수령'이 있을 때만 수령. '라이브 시청'으로 바뀌면(더 봐야 함) 종료.
    if (!findAny(cfg().texts.liveClaim, 700)) break;
    tapText(cfg().texts.liveClaim, "라이브 포인트 수령", 300);
    stat.cycles++;
    sleep(cfg().timing.afterTapReward);
    // ★ 수령 직후 '선물 보내고 추가 리워드 받기[보내기]' 유도 팝업이 뜨면 back으로만 닫음.
    //   (절대 '보내기'를 누르지 않음 — 감지 전용 문구로만 판단)
    if (findAny(cfg().texts.giftUpsell, 500)) {
      log("선물 유도 팝업 감지 → back으로 닫음(선물 안 보냄)");
      back(); sleep(700);
    }
  }
}

// 라이브에서 리워드 페이지로 복귀. 라이브를 나가면 '피드'로 나오므로
// back은 '피드(포인트 탭 보임)까지'만 하고(앱 종료 방지) '포인트' 탭으로 리워드 진입.
function exitLiveToRewards() {
  for (var b = 0; b < 3 && running; b++) {
    if (findAny(cfg().texts.pageMarker, 250)) return;   // 이미 리워드 페이지
    if (findAny(cfg().texts.pointsTab, 250)) break;     // 피드 도달 → 더 back 금지(앱 종료 방지)
    back(); sleep(800);
  }
  ensureOnRewardsPage(); // 피드의 '포인트' 탭(텍스트→좌표)으로 리워드 페이지 복귀
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

// 현재 액티비티 이름(실패 시 빈 문자열). 피드/광고/게임 화면 판정에 사용.
function curActivity() {
  try { return String(currentActivity() || ""); } catch (e) { return ""; }
}
// 현재 액티비티가 '광고 랜딩/리워드광고 등 접근성 미노출(Lynx/Spark)' 화면인지.
//  ★ 이런 화면은 텍스트로 안 잡혀 갇히므로 액티비티명으로 판정 → back으로 탈출.
function onStuckActivity() {
  var act = curActivity();
  if (!act) return false;
  var list = cfg().stuckActivities || [];
  for (var i = 0; i < list.length; i++) if (act.indexOf(list[i]) >= 0) return true;
  return false;
}

// 광고/랜딩(비접근성 Lynx/Spark) 화면에서 리워드/피드로 강제 탈출.
//  ★ 실측: 광고 종료 후 'RewardAdActivity'의 upsell 팝업('나중에 하기')은 Lynx라
//    텍스트/back으로 안 닫히고 '하단 중앙 X 좌표'로만 닫힘. 'SparkActivity'(Temu 랜딩)는
//    back으로 나옴. 화면(액티비티)에 맞춰 방법을 달리해 확실히 빠져나온다.
//  @return true = 정상 화면(리워드/피드) 도달, false = 6회 안에 못 나감
function bailFromAdStack() {
  for (var i = 0; i < 6 && running; i++) {
    if (detectCaptcha()) return false;
    if (findAny(cfg().texts.pageMarker, 250)) return true;   // 리워드 페이지
    if (findAny(cfg().texts.pointsTab, 200)) return true;    // 피드 도달('포인트' 탭 보임)
    if (!onStuckActivity() && !inAdScreen()) return true;    // 광고/랜딩 아님 = 정상
    var act = curActivity();
    if (act.indexOf("RewardAd") >= 0 || act.indexOf("reward.ui") >= 0) {
      // 리워드광고 upsell 팝업 → 상단/하단 X 좌표로 닫기(Lynx라 텍스트 불가)
      tapRatio(cfg().coords.adClose, "광고 X(상단)"); sleep(350);
      tapRatio(cfg().coords.adRewardClose, "광고리워드 X(하단)"); sleep(650);
    } else {
      // Spark 랜딩 등 → back으로 탈출
      back(); sleep(800);
    }
  }
  return false;
}

// ★ 피드 시청 중 '게임 광고/게임 화면/광고 랜딩'에 잘못 들어갔는지 즉시 감지·탈출.
//   1) 피드에 낀 게임 광고 → '관심 없음' 등으로 닫음(스와이프로 게임 진입 방지)
//   2) 게임 화면(진입/보드) 텍스트 감지 → 뒤로가기로 피드 복귀
//   3) 광고 랜딩/리워드광고(비접근성 Lynx/Spark) 액티비티에 갇힘 → 뒤로가기로 탈출
//      (텍스트로 안 잡히므로 currentActivity로 판정. 피드 액티비티면 매칭 안 돼 무해)
//   @return true = 뭔가 처리함(이번 스와이프 건너뜀)
function escapeIfGame() {
  if (tapText(cfg().texts.gamePromoClose, "게임광고 닫기", 150)) { sleep(400); return true; }
  if (findAny(cfg().texts.gameScreen, 150)) {
    log("피드 이탈(게임 화면) 감지 → 즉시 뒤로가기 복귀");
    back(); sleep(900);
    tapText(cfg().texts.gamePromoClose, "게임광고 닫기", 150); // 나오자마자 또 광고면 닫기
    return true;
  }
  if (onStuckActivity()) {
    log("피드 이탈(광고/랜딩 액티비티 '" + curActivity() + "') → 뒤로가기 탈출");
    back(); sleep(1000);
    return true;
  }
  return false;
}

// 피드를 지정 시간만큼 스크롤하며 시청 + 주기적으로 남은 시간 로그.
// ★ 멈춤 감지(2026-07-06 의뢰인 사진): 앱 재실행 직후 '14일 연속 출석' 같은 모달이
//   피드를 덮으면 스와이프가 안 먹혀 몇 시간을 헛돌 수 있음. 스와이프를 했는데도
//   화면 텍스트 지문(screenSig)이 2번 연속 그대로면 = 막힌 것 → 팝업 정리(clearAllPopups,
//   좌표 ✕ 포함) → 그래도 그대로면 뒤로가기. 정상 시청 중엔 영상마다 지문이 바뀌므로
//   오탐 없음(스와이프 실패가 2회 연속일 때만 발동).
function scrollFeedUntil(untilMs) {
  var nextTick = 0, lastSig = null, stuckN = 0;
  while (running && Date.now() < untilMs) {
    if (!ensureForeground(false)) { sleep(3000); continue; }
    if (escapeIfGame()) continue;      // 스와이프 '전' 검사(광고 먼저 닫기)
    checkAndClosePopup();
    swipeToNextVideo();
    if (escapeIfGame()) continue;      // ★ 스와이프 '직후' 즉시 검사 → 게임 진입 8초 안 기다리고 바로 탈출
    // ── 멈춤 감지: 스와이프 후에도 화면이 그대로인가? ──
    var sig = screenSig();
    if (sig && sig === lastSig) {
      if (++stuckN >= 2) {
        log("⚠ 피드 멈춤 감지(스와이프 후에도 화면 불변) → 팝업 정리");
        clearAllPopups("피드 멈춤");
        if (screenSig() === sig) { back(); sleep(800); } // 팝업 정리로도 그대로면 뒤로가기
        stuckN = 0; lastSig = null;
        continue;
      }
    } else { stuckN = 0; }
    lastSig = sig;
    if (Date.now() > nextTick) {
      var leftMin = Math.max(0, Math.ceil((untilMs - Date.now()) / 60000));
      log("영상 시청 중… 시청 종료까지 약 " + leftMin + "분");
      nextTick = Date.now() + 30000;
    }
    napChunked(jitter(cfg().timing.scrollIntervalMs), isRunningFlag);
  }
}

// 리워드 페이지에서 '출석'만 수행(마지막 단계용)
function doAttendanceOnly() {
  if (!ensureOnRewardsPage()) return;
  closeStickyBanner();
  // exact=false: "오늘 출석하고 200 받기"(복귀 프로모) / "출석하기"(표준) 모두 부분매칭.
  //  회색 '내일 출석하고…'·카드 제목과는 안 겹침(config 주석 참고).
  if (tapText(cfg().texts.attendance, "출석", 1500, false)) {
    sleep(cfg().timing.afterTapReward);
    collectPopup(); stat.cycles++;
    log("출석체크 완료");
  } else {
    log("출석체크 버튼 없음(이미 했거나 오늘 없음)");
  }
}

// 종료 직전 1회 수확 — 의뢰인 확정 순서(2026-07-06):
//  ① 20분 타이머 받기 — 누르면 뜨는 '광고 보기' 팝업(안 뜰 때도 있음)의 광고까지
//     collectPopup이 시청·수령 처리
//  ② 좋아요 미션 '포인트 받기' — 시청 중 좋아요를 눌러뒀으므로 활성화돼 있음
//  ③ 매일 광고 1회(dailyAdBatch=1, 하루 1번만)
//  ④ 출석체크(마지막)
function finalHarvest() {
  log("⏰ 마무리 수확: 타이머 → 좋아요 → 매일광고 1회 → 출석");
  if (!ensureOnRewardsPage()) return;
  harvestDeadline = Date.now() + (cfg().timing.harvestBudgetMs || 480000);
  clearAllPopups("포인트 팝업");
  closeStickyBanner();

  // ① 타이머 — '광고 보기' 팝업이 뜨면 그 광고도 보고 수령(팝업 없으면 그냥 수령)
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

  // ② 좋아요 미션 '포인트 받기' — noFallback: 버튼이 '미션 완료/시작하기' 상태면
  //    좌표 폴백 없이 스킵(엉뚱한 탭 방지)
  if (running) {
    scrollRewardsTop();
    var lc = findCard(cfg().texts.likeTitle, 6);
    if (lc) {
      if (tapCardButton(lc.node, cfg().texts.pageClaim, "좋아요 받기", true)) {
        sleep(cfg().timing.afterTapReward); collectPopup(); stat.cycles++;
      } else {
        log("좋아요 '포인트 받기' 없음(미활성/이미 수령) → 스킵");
      }
      ensureOnRewardsPage(); closeStickyBanner();
    }
  }

  // ③ 매일 광고 — 하루 1회만(dailyAdBatch=1)
  if (running) watchDailyAdBatch();

  // ④ 출석체크(마지막)
  if (running) doAttendanceOnly();
}

// 최종 플로우(의뢰인 확정 2026-07-06):
//   앱 실행 → 팝업 종료 → 첫 영상 좋아요 → 영상 시청만 꾸준히(중간 수확 없음, ~15초/개)
//   → 시간 종료 후 포인트 페이지 1회 진입(finalHarvest) → 앱 종료.
// ※ 중간(20분마다) 수확을 없앤 이유: 페이지 전환이 적을수록 멈춤/오류가 적음(의뢰인 요청).
//   타이머를 자주 받고 싶으면 config.harvestEveryCycle=true로 예전 방식 사용 가능.
function runFarm() {
  var total = cfg().timing.totalRunMs || (160 * 60 * 1000);
  log("[최종 플로우] 영상시청 " + Math.round(total / 60000) + "분 → 종료 직전 1회 수확·출석");

  safe("실행", function () { ensureForeground(true); });          // 1. TikTok Lite 실행
  safe("팝업", function () { clearAllPopups("영상화면 팝업"); }); // 2. 영상화면 팝업 종료(출석팝업 ✕ 포함)

  var end = Date.now() + total;

  if (cfg().harvestEveryCycle) {
    // (옵션) 예전 방식: 20분 시청 ↔ 수확 반복 — 기본 꺼짐
    while (running && Date.now() < end) {
      safe("피드시청", function () {
        gotoFeed(); sleep(1500);
        if (!findAny(cfg().texts.pageMarker, 300)) {
          tapRatio(cfg().coords.feedLike, "첫 영상 좋아요");
        }
        scrollFeedUntil(Math.min(end, Date.now() + cfg().timing.betweenCycleMs));
      });
      if (!running || Date.now() >= end) break;
      safe("수확", function () { log("⏰ 리워드 수확"); harvestRewards(false); });
    }
  } else {
    // 기본: 3. 첫 영상 좋아요 → 4. 영상 시청만 쭉(중간에 포인트 페이지 안 감)
    safe("피드시청", function () {
      gotoFeed(); sleep(1500);
      // ★ 피드로 확실히 나온 경우에만 좋아요(리워드 페이지 표식이 안 보일 때).
      if (!findAny(cfg().texts.pageMarker, 300)) {
        tapRatio(cfg().coords.feedLike, "첫 영상 좋아요");        // 좋아요 미션 활성화
      }
      scrollFeedUntil(end);                                       // 팝업 닫으며 끝까지 시청
    });
  }

  // 시간이 만료되어 끝난 경우에만(사용자 정지가 아님) 마무리 단계 수행
  if (running) {
    safe("마무리수확", finalHarvest);    // 5~8. 타이머→좋아요→매일광고1회→출석
    safe("앱종료", stepCloseApp);         // 9. 앱 종료
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
