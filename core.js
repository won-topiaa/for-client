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
// findAny의 boolean 전용 래퍼 — 매칭 노드를 즉시 recycle해 누수를 막는다.
//  (결과를 '화면에 있나?' 진위로만 쓰는 hot-path 게이트 체크에 사용)
function exists(list, timeoutMs, exact) {
  var f = findAny(list, timeoutMs, exact);
  if (!f) return false;
  try { f.node.recycle(); } catch (e) {}
  return true;
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
  try { f.node.recycle(); } catch (e) {}
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
// 하단 '포인트' 탭으로 리워드 진입 시도 — 텍스트 우선, 없으면 나브 좌표 폴백(중복 제거용 헬퍼)
function tapPointsTab() {
  if (!tapText(cfg().texts.pointsTab, "포인트 탭", 400)) {
    tapRatio(cfg().coords.pointButton, "포인트 탭(좌표)");
  }
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
  var maxClicks = cfg().popup.maxRounds || 6; // 총 닫기 클릭 상한(핑퐁 방지)
  var recent = []; // 최근 클릭한 닫기 텍스트(핑퐁 A,B,A,B 감지용)
  for (var c = 0; c < maxClicks; c++) {
    if (detectCaptcha()) return false;
    // ★ 이미 리워드 페이지가 보이면 더 이상 닫지 않음
    //   (페이지 내용의 확인/닫기 오클릭 + 핑퐁 무한반복 방지)
    if (exists(cfg().texts.pageMarker, 200)) return true;
    // 1) 텍스트/desc 닫기
    var f = findAny(cfg().texts.close, 400);
    if (f) {
      log((label || "팝업") + " 닫기 '" + f.matched + "'");
      clickNode(f.node); try { f.node.recycle(); } catch (e) {} sleep(gap);
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
    var eventOnly = !exists(cfg().texts.pageMarker, 150) && exists(cfg().texts.eventPopup, 200);
    if (eventOnly) {
      var spots = cfg().coords.eventCloseSpots || [];
      var closed = false;
      for (var s = 0; s < spots.length; s++) {
        tapRatio(spots[s], "이벤트팝업 ✕후보" + (s + 1));
        sleep(gap);
        if (detectCaptcha()) return false;
        if (!exists(cfg().texts.eventPopup, 300)) { closed = true; break; }
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
function atGameZone() { return exists(cfg().texts.gameTitle, 150); }

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
        try { n.recycle(); } catch (e3) {} // ★ 자식 노드 반드시 회수(3시간 런 누수/OOM 방지)
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
            if (clickNode(n)) { try { n.recycle(); } catch (e4) {} sleep(jitter(cfg().timing.shortWait)); return true; }
          }
          try { n.recycle(); } catch (e5) {} // 안 누른 후보 노드 회수(누수 방지)
        }
      } finally { try { col.recycle(); } catch (e) {} }
    }
    // noFallback=true면 지정 버튼 텍스트가 없을 때 좌표 폴백을 하지 않음.
    //  (좋아요 카드처럼 버튼이 '미션 완료/시작하기'로 바뀌는 카드에서
    //   우측 좌표를 눌러 엉뚱한 걸 탭하는 사고 방지)
    if (noFallback) { log(label + " 지정 버튼 없음 → 스킵(폴백 안 함)"); return false; }
    var x = Math.round(W * 0.80), y = tb.centerY();
    // ★ 클램프 가드: RecyclerView 가상화로 카드 bounds가 화면 밖(y≈0 또는 하단 H)으로
    //   클램프되면 이 좌표는 엉뚱한 곳(하단 게임카드 등)을 눌러 오탭 위험 → 폴백 스킵.
    if (y > H * 0.90 || y < H * 0.06) {
      log(label + " 카드 좌표 클램프(y=" + y + ") → 좌표폴백 스킵(오탭 방지)"); return false;
    }
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
  if (exists(cfg().texts.pageMarker, 300)) return true;
  // 표식(상단 전용)이 안 보여도, 리워드 '콘텐츠'가 보이면 = 스크롤된 리워드 페이지.
  //   (게임 카드 / '포인트 받기' / '시청' 버튼 중 하나라도 보이면 페이지 안으로 인정)
  //   이때만 맨 위로 올려 표식을 재확인 → 피드/광고 화면에서 헛스크롤하지 않음.
  var t = cfg().texts;
  if (atGameZone() || exists(t.pageClaim, 150) || exists(t.watchBtn, 150) ||
      exists(t.timerTitle, 150) || exists(t.dailyAdCard, 150)) {
    if (scrollRewardsTop()) return true;
    return true; // 리워드 콘텐츠가 확실히 보였으니 페이지 안으로 간주(표식만 못 올라온 경우)
  }
  return false; // 리워드 콘텐츠가 전혀 안 보임 = 페이지 밖(피드/광고 등)
}
// 피드를 덮는 캔버스(Lynx) 모달을 닫는다. 두 종류가 있고 ✕ 위치가 서로 다르다(실측):
//  ① 게임 프로모 팝업(돼지저금통/슈팅마블/킥오프/원판 등) → 하단 중앙 ✕ ≈ 0.50,0.72
//  ② '14일 연속 출석하고 포인트 받기' 출석 모달 → 더 아래 ✕ ≈ 0.50,0.79 (2026-07-07 실측)
//  둘 다 캔버스라 텍스트/back·접근성 트리로 감지가 안 됨 → 닫힘 성공 여부를 확인할 수 없으니
//  알려진 ✕ 후보를 순서대로 모두 눌러 본다. 모달이라 안 닫으면 하단 '포인트' 탭까지 가로막아
//  리워드 진입이 통째로 실패한다(시작타이머·시작광고·마무리수확 전부).
//  ※ 팝업이 없을 때 이 지점들은 '영상 중앙 하단' → 단일 탭은 무해(일시정지 토글 정도,
//    좋아요=더블탭이라 영향 없음). 출석 '출석하기' 버튼(≈0.69)·게임 '시작하기'(≈0.60)는
//    후보(0.72/0.79)보다 위라 안 눌림(오탭·의도치 않은 출석수령 방지).
function dismissFeedGamePopup() {
  // ★ 피드 하단 '중앙 세로 라인'의 ✕ 후보만 누른다(우상단 등은 검색/딴화면 위험이라 제외).
  //   config feedModalCloseYs는 '안전한 순'(아래 0.79 → 0.72 → 위험대역 0.65). 안전장치:
  //    · 캡차/보안 화면이면 블라인드 탭 금지(정지 유도)
  //    · 위험대역(y<0.70, 예: 킥오프 0.65)은 다른 팝업 CTA와 겹칠 수 있어 → '포인트' 나브가
  //      아직 안 보일 때(=여전히 막힘)만, 안전후보 뒤에 마지막으로 시도
  //    · 위험대역 탭이 혹시 게임/이벤트로 진입시켰으면 즉시 back으로 자가복구
  if (detectCaptcha()) return;
  var ys = cfg().coords.feedModalCloseYs;
  if (!(ys && ys.length)) ys = [0.79, 0.72, 0.65];
  for (var i = 0; i < ys.length; i++) {
    var risky = ys[i] < 0.70;
    if (risky && exists(cfg().texts.pointsTab, 150)) return; // 이미 나브 보임 → 위험탭 생략
    tapRatio({ x: 0.50, y: ys[i] }, "피드팝업 닫기 ✕후보" + (i + 1) + "(y" + ys[i] + ")");
    sleep(350);
    if (detectCaptcha()) return;
    if (risky && (exists(cfg().texts.gameScreen, 150) || onStuckActivity())) {
      log("팝업 닫기 위험후보가 게임/이벤트 진입 유발 → back 탈출");
      back(); sleep(700);
    }
  }
}

function ensureOnRewardsPage() {
  var extBounces = 0; // 외부 앱(Temu 등) 반복 튕김 횟수 — 무한 탭-재실행 루프 차단용
  var pointTried = false; // 안전한 '포인트' 탭을 이미 시도했는지(중앙 X는 그 뒤에만)
  // ★ 벽시계 상한(무한루프는 아니지만, 외부앱/광고 튕김이 겹치면 한 번 진입에 수십초~분 단위로
  //   조용히 매달릴 수 있음) → 예산 초과 시 깔끔히 실패 반환. 호출부는 실패를 안전 처리한다.
  var entryDeadline = Date.now() + (cfg().timing.entryBudgetMs || 90000);
  for (var i = 1; i <= 5; i++) {
    if (Date.now() > entryDeadline) { log("⚠ 리워드 진입 시간초과(" + Math.round((cfg().timing.entryBudgetMs || 90000) / 1000) + "초) → 실패 반환"); return false; }
    // 덮고 있는 팝업(광고 후 '광고 시청하고 추가 리워드[나중에 하기]' 등)부터 닫고 표식 확인
    clearAllPopups("진입 팝업");
    if (onRewardsPageNow()) return true;   // 스크롤 위치 무관하게 페이지 판정
    // ★ 화면 종류에 맞게 복귀 (순서 중요):
    //   1) 광고/랜딩(비접근성 Lynx/Spark 액티비티)에 갇힘 → bailFromAdStack로 확실히 탈출
    //   2) 우리 앱 안(피드 등) → 게임팝업 닫고 '포인트' 탭으로 리워드 진입
    //   3) 앱 밖 → back으로 복귀
    if (onStuckActivity()) {
      log("광고/랜딩('" + curActivity() + "') 갇힘 → 스택 탈출 " + i + "/5");
      bailFromAdStack();
    } else if (isOurApp(currentPackage())) {
      // ★ 진입 2단계 (2026-07-06 3차 검증 — 피드 Temu 광고 오탭 방지):
      //   피드는 캔버스(Lynx/GL)라 '포인트' 텍스트가 간헐적으로만 잡히고, 피드에 Temu
      //   전면/게임 광고가 자주 껴서 '화면 중앙'을 누르면 그 광고 CTA가 눌려 Temu가 열림.
      //   그래서:
      //    1단계) 먼저 '포인트' 탭만 누른다(텍스트 우선, 없으면 하단 나브 좌표 0.30,0.92).
      //           하단 나브는 영상/광고 CTA와 안 겹쳐 안전(Temu 실수 실행 없음).
      //    2단계) 그래도 리워드로 안 넘어가면:
      //           · 광고 화면(스턱/adMarker)으로 재감지되면 → 중앙탭 금지, 스택 탈출(bail)
      //           · 아니면 게임 프로모 팝업(돼지저금통 등)이 하단 탭을 막는 것 → 그때만
      //             중앙 X(0.50,0.72)로 팝업을 닫고 '포인트' 재시도.
      if (!pointTried) {
        log("피드 → 포인트 탭(안전) 진입 " + i + "/5");
        tapPointsTab();
        pointTried = true;
      } else if (onStuckActivity() || inAdScreen()) {
        log("광고 화면 재감지 → 중앙탭 금지, 스택 탈출 " + i + "/5");
        bailFromAdStack();
      } else {
        log("포인트만으론 미진입 → 게임팝업 X 닫고 재시도 " + i + "/5");
        dismissFeedGamePopup();
        tapPointsTab();
      }
      sleep(cfg().timing.afterTapReward);
    } else {
      // 앱 밖(외부 앱 — 광고가 띄운 Temu/스토어 등). back으론 우리 앱 복귀 불가 → 재실행.
      // ★ 단, 광고(Temu)가 '광고 CTA'를 통해 계속 재실행돼 우리 앱↔Temu를 왕복하는
      //   무한 루프가 생길 수 있음(복귀 직후 진입 탭이 광고 CTA를 다시 누름). 2회 이상
      //   외부로 튕기면 탭을 멈추고 포기한다(무한 루프·과탭 방지). 광고 크레딧은 이미
      //   지급됐고, 남은 단계는 각자 안전 스킵되므로 손실 최소.
      if (++extBounces >= 2) {
        log("외부앱 반복 튕김('" + currentPackage() + "') → 진입 포기(무한 탭 방지)");
        launchApp(true);
        return false;
      }
      log("앱 밖(" + currentPackage() + ") → TikTok 재실행 복귀 " + i + "/5");
      launchApp(true);
    }
    clearAllPopups("진입 팝업");
    if (onRewardsPageNow()) { log("리워드 페이지 확인됨"); return true; }
  }
  log("⚠ 리워드 페이지 진입 실패");
  return false;
}

// 버튼 위치 기반 키(같은 자리 버튼 중복 클릭 방지용)
var _nodeKeySeq = 0;
function nodeKey(f) {
  try {
    var b = f.node.bounds();
    if (b) return f.matched + "@" + Math.round(b.centerX() / 20) + "," + Math.round(b.centerY() / 20);
  } catch (e) {}
  return f.matched + "#" + (++_nodeKeySeq); // bounds 없으면 유니크 키 → 중복병합(수령 누락) 방지
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
        clickNode(fa.node); try { fa.node.recycle(); } catch (e) {} sleep(cfg().timing.afterTapReward);
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
    clickNode(f.node); try { f.node.recycle(); } catch (e) {} sleep(cfg().timing.afterPopupClose);
  }
}

// 광고 화면인지 확인(상단 "15초 시청하고 30포인트 받기")
function inAdScreen() {
  return exists(cfg().texts.adMarker, 500);
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
// humanize 시 x오프셋/궤적속도/대기를 매번 다르게(고정 좌표 반복 = 봇 지문 완화).
//  y끝점은 상단 제어판(≈y<0.25H)을 피하려 그대로 유지(0.31↔0.85).
function _rSwipe(y1r, y2r) {
  var hz = cfg().humanize;
  var ox1 = hz ? rnd(-W * 0.05, W * 0.05) : 0, ox2 = hz ? rnd(-W * 0.04, W * 0.04) : 0;
  var dur = Math.round(hz ? rnd(300, 430) : 350);
  swipe(Math.round(W * 0.5 + ox1), Math.round(H * y1r), Math.round(W * 0.5 + ox2), Math.round(H * y2r), dur);
  sleep(Math.round(hz ? rnd(280, 430) : 350));
}
function scrollRewardsUp()   { _rSwipe(0.31, 0.85); }
function scrollRewardsDown() { _rSwipe(0.85, 0.31); }
// ★ 핵심 수정: '맨 위'는 고정 횟수가 아니라 상단 표식이 보일 때까지(또는 더 이상
//   안 올라갈 때까지) 반복해서 올린다. 긴 페이지에서 위로 못 돌아오던 버그의 해결.
function scrollRewardsTop() {
  var last = null;
  for (var i = 0; i < 14 && running; i++) {
    if (exists(cfg().texts.pageMarker, 150)) return true; // 최상단 도달
    scrollRewardsUp();
    var sig = screenSig();
    if (sig && sig === last) break; // 더 이상 안 올라감(최상단 or 스크롤 막힘)
    last = sig;
  }
  return exists(cfg().texts.pageMarker, 150);
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
    var k = f ? nodeKey(f) : null;
    if (f && !seen[k]) {
      seen[k] = 1;
      log("리워드 수령 '" + f.matched + "'");
      clickNode(f.node); try { f.node.recycle(); } catch (e) {} sleep(cfg().timing.afterTapReward);
      collectPopup(); stat.cycles++;
      noFind = 0;
    } else {
      if (f) { try { f.node.recycle(); } catch (e) {} }
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
      // noFallback=true: 타이머가 아직 충전 안 됐으면(20분 주기 미도래) 카드에 '포인트 받기'가
      //   없음 → 좌표 블라인드 폴백 금지(클램프된 bounds/게임 카드 오탭 방지). 준비됐을 때만
      //   '포인트 받기' 텍스트로 정확히 눌러 수령한다.
      if (tapCardButton(tc.node, cfg().texts.pageClaim, "타이머 받기", true)) {
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

// '매일 광고' 카드의 '시청' 버튼을 눌러, 지금 이 방문에서 열리는 만큼 광고를 시청한다.
//  반환값: 이번 방문에서 실제로 시청·적립한 개수(주기 수집 루프가 누적/종료 판단에 사용).
//  ★ 하루 한도(현재 40개)에 하드코딩하지 않는다: perVisitCap은 '한 방문 안전 상한'(무한루프
//    방지)일 뿐이고, 실제 종료는 "광고가 더 이상 안 열림"(세션캡/쿨다운/한도소진)으로 판단한다.
//    → 매일광고는 한 번에 다 못 볼 수 있어(세션당 N개 제한), 이 함수를 runFarm이 시청 중
//      ~20분마다 반복 호출한다. 이번 방문에 안 열리면 0을 반환하고 다음 방문에서 다시 시도.
//    TikTok이 한도/세션 숫자를 바꿔도(상한 이내라면) 코드 수정 없이 열리는 만큼 자동 대응.
function watchDailyAdBatch() {
  var cap = cfg().dailyAdBatch || 0;          // 하루 누적 안전 상한
  var perVisit = cfg().adPerVisitCap || cap;  // 한 방문 안전 상한(무한루프 방지; 기본=하루 상한)
  if (cap <= 0) return 0;
  log("매일 광고 시청 시도(이번 방문 상한 " + perVisit + "개 — 열리는 만큼만)");
  var watched = 0;                            // 이번 방문에 실제로 시청·적립한 개수
  for (var i = 0; i < perVisit && running; i++) {
    if (Date.now() > harvestDeadline) { log("수확 시간 초과 → 매일광고 방문 종료(" + watched + "개 봄)"); break; }
    if (!ensureOnRewardsPage()) { log("리워드 진입 실패 → 매일광고 방문 종료(" + watched + "개 봄)"); break; }
    closeStickyBanner(); scrollRewardsTop();
    var card = findCard(cfg().texts.dailyAdCard, 6);
    if (!card) { log("매일 광고 카드 없음 → 방문 종료(" + watched + "개 봄)"); break; }
    // noFallback=true: 카드 행에 '시청' 버튼이 없으면(한도 소진/'완료' 표시/UI 상이)
    //   좌표 블라인드 폴백 금지(카드 우측 헛탭 방지). 아래 inAdScreen 체크가 안 열림을
    //   잡아 안전히 종료한다. 리워드 페이지는 텍스트가 잡히므로 정상 시엔 '시청'을 텍스트로 누름.
    if (!tapCardButton(card.node, cfg().texts.watchBtn, "매일광고 '시청'", true)) {
      log("'시청' 버튼 없음 = 지금은 더 못 봄(세션캡/한도) → 방문 종료(" + watched + "개 봄)"); break;
    }
    sleep(cfg().timing.afterTapReward);
    if (detectCaptcha()) return watched;
    if (!inAdScreen()) { log("광고 안 열림 = 세션캡/쿨다운/한도 → 방문 종료(" + watched + "개 봄)"); break; }
    if (closeAd()) { stat.cycles++; watched++; log("매일 광고 이번 방문 " + watched + "개째 완료"); }
    collectPopup();
  }
  if (ensureOnRewardsPage()) scrollRewardsTop();
  return watched;
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
    tapCardButton(card.node, cfg().texts.watchBtn, "라이브 '시청'", true);
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
    // 사용자 정지(worker.interrupt)로 인한 예외는 '오류'가 아님 → 조용히 넘김
    //  (제어판 lastError에 무서운 오류로 남지 않게 + 정지 후 앱 재실행/추가동작 방지)
    if (!running || String(e).indexOf("Interrupt") >= 0) { log(name + " 중단(사용자 정지)"); return; }
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
    if (!exists(cfg().texts.pageMarker, 400)) return; // 이미 피드
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
    // ★ 실측(2026-07-06): 광고(특히 Temu 광고)가 '외부 앱'(com.einnovation.temu/Play스토어
    //   등)을 실제로 실행시키는 경우가 있음. 이땐 back으로는 TikTok에 못 돌아옴(외부 앱
    //   안에서만 돎) → 우리 앱을 재실행해 복귀한다. (isOurApp 체크를 아래 '정상' 판정보다
    //   먼저 둬서, 외부 앱을 '광고 아님=정상'으로 오판하고 빠져나온 척하지 않게 함)
    if (!isOurApp(currentPackage())) {
      log("광고가 외부앱('" + currentPackage() + "') 실행 → TikTok 재실행 복귀");
      launchApp(true);
      continue;
    }
    if (!onStuckActivity() && !inAdScreen()) return true;    // 우리 앱의 정상 화면 = 탈출 완료
    var act = curActivity();
    if (act.indexOf("RewardAd") >= 0 || act.indexOf("reward.ui") >= 0) {
      // 리워드광고 upsell 팝업 → 상단/하단 X 좌표로 닫기(Lynx라 텍스트 불가)
      tapRatio(cfg().coords.adClose, "광고 X(상단)"); sleep(350);
      tapRatio(cfg().coords.adRewardClose, "광고리워드 X(하단)"); sleep(650);
      // ★ 실측(2026-07-09): 매일광고(올리브영/Temu 등)가 RewardAd→인앱 웹뷰 랜딩
      //   (AdLandingPageFullScreenActivity)까지 여는 경우, 그 랜딩의 닫기 X는 '좌상단'이라
      //   위 우상단/하단 좌표로는 안 닫힘. 이 광고 스택은 back이 한 겹씩 확실히 벗겨
      //   (Landing→RewardAd→Spark→피드, 실측 back 3회면 피드 도달) 주므로, 좌표 X로도
      //   여전히 광고/랜딩에 갇혀 있으면 back으로 한 겹 벗긴다.
      if (onStuckActivity() || inAdScreen()) { back(); sleep(800); }
    } else {
      // Spark 랜딩/웹뷰 랜딩 등 → back으로 탈출
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

// 영상 1개당 시청(체류) 시간 — 사람처럼 분포를 준다(고정 ~15초 반복 = 봇 지문 완화).
//  기준(scrollIntervalMs, ~15초)을 '최빈값'으로 두되: 가끔 빨리 넘기고(스킵), 가끔 오래 본다.
//  의뢰인 확정 "약 15초"는 중심경향으로 유지되고, 균일값만 피한다.
function videoDwellMs() {
  var base = cfg().timing.scrollIntervalMs;
  if (!cfg().humanize) return base;
  var r = Math.random();
  if (r < 0.15) return Math.round(rnd(base * 0.25, base * 0.60)); // 15%: 빨리 넘김
  if (r < 0.90) return Math.round(rnd(base * 0.85, base * 1.25)); // 75%: ~기준(약 15초)
  return Math.round(rnd(base * 1.80, base * 3.50));               // 10%: 관심 영상 오래 봄
}

// 피드를 지정 시간만큼 스크롤하며 시청 + 주기적으로 남은 시간 로그.
// ★ 멈춤 감지(2026-07-06 의뢰인 사진): 앱 재실행 직후 '14일 연속 출석' 같은 모달이
//   피드를 덮으면 스와이프가 안 먹혀 몇 시간을 헛돌 수 있음. 스와이프를 했는데도
//   화면 텍스트 지문(screenSig)이 2번 연속 그대로면 = 막힌 것 → 팝업 정리(clearAllPopups,
//   좌표 ✕ 포함) → 그래도 그대로면 뒤로가기. 정상 시청 중엔 영상마다 지문이 바뀌므로
//   오탐 없음(스와이프 실패가 2회 연속일 때만 발동).
function scrollFeedUntil(untilMs) {
  var nextTick = 0, lastSig = null, stuckN = 0, blindN = 0;
  // ★ '전진 없음' 워치독: 정상 1회전은 '스와이프로 다음 영상 진입'까지 도달한다. 포그라운드
  //   이탈/광고 오버레이/게임루프 때문에 스와이프까지 못 가고 continue만 반복하면(깜빡여서
  //   연속카운터로는 안 잡히는 경우 포함) noSwipe가 쌓인다 → 점진 복구, 그래도 안 되면 이
  //   시청 청크를 조기 종료(다음 단계로). 긴 시청 나프는 스와이프 '후'라 오탐 없음.
  var noSwipe = 0;
  while (running && Date.now() < untilMs) {
    if (noSwipe && noSwipe % 6 === 0) {  // ~비스와이프 6회마다 능동 복구
      log("⚠ 피드 전진 없음(" + noSwipe + "회) → 복구(재실행/스택탈출/팝업정리)");
      ensureForeground(true); bailFromAdStack(); clearAllPopups("피드 정체");
    }
    if (noSwipe >= 20) { log("⚠ 피드 정체 지속 → 이번 시청 청크 조기 종료(다음 단계로)"); return; }

    if (!ensureForeground(false)) { noSwipe++; sleep(3000); continue; }
    if (escapeIfGame()) { noSwipe++; continue; }   // 스와이프 '전' 검사(광고 먼저 닫기)
    checkAndClosePopup();
    swipeToNextVideo();
    if (escapeIfGame()) { noSwipe++; continue; }   // ★ 스와이프 '직후' 즉시 검사 → 게임 진입 바로 탈출
    noSwipe = 0;                                    // 스와이프 성공 = 전진
    // ── 피드 '광고 영상'(배지 정확일치)은 시청 크레딧이 안 쌓임 → 즉시 다음 영상으로
    //   (의뢰인 2026-07-08: 광고·팝업은 빨리 지나가게 — 시청시간으로 안 잡히므로) ──
    if (exists(cfg().texts.feedAdBadge, 250, true)) {
      log("피드 광고 영상 감지 → 바로 넘김");
      sleep(Math.round(rnd(600, 1200)));           // 사람처럼 아주 잠깐 보고
      continue;                                    // 시청 대기 없이 곧장 다음 스와이프
    }
    // ── 멈춤 감지: 스와이프 후에도 화면이 그대로인가? ──
    var sig = screenSig();
    if (sig === null) {
      // 캔버스라 텍스트 지문이 없음 → '덮은 모달/스턱이 확실할 때만' 복구(정상 피드 오탐 방지).
      if (++blindN >= 3 && (exists(cfg().texts.eventPopup, 150) || onStuckActivity())) {
        log("⚠ 피드 지문 없음 + 덮개(모달/광고) 감지 → 정리/탈출");
        clearAllPopups("피드 지문없음");
        if (onStuckActivity()) { back(); sleep(800); }
        blindN = 0;
      }
    } else {
      blindN = 0;
      if (sig === lastSig) {
        if (++stuckN >= 2) {
          log("⚠ 피드 멈춤 감지(스와이프 후에도 화면 불변) → 팝업 정리");
          clearAllPopups("피드 멈춤");
          if (screenSig() === sig) { back(); sleep(800); } // 팝업 정리로도 그대로면 뒤로가기
          stuckN = 0; lastSig = null;
          continue;
        }
      } else { stuckN = 0; }
    }
    lastSig = sig;
    if (Date.now() > nextTick) {
      var leftMin = Math.max(0, Math.ceil((untilMs - Date.now()) / 60000));
      log("영상 시청 중… 시청 종료까지 약 " + leftMin + "분");
      nextTick = Date.now() + 30000;
    }
    napChunked(videoDwellMs(), isRunningFlag);
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

// 타이머 '포인트 받기' 1회 수령 — 의뢰인 확정(2026-07-06 2차):
//   20분마다 반복 수령은 봇 의심 우려 → "시작 때 1번 + 종료 때 1번"만 수행.
//   누르면 뜨는 '광고 보기' 팝업(안 뜰 때도 있음)의 광고까지 collectPopup이 처리.
//   noFallback: 타이머가 아직 충전 안 됐으면(카운트다운 표시) 카드에 '포인트 받기'가
//   없음 → 좌표 블라인드 폴백 금지(클램프된 bounds/게임 카드 오탭 방지). 준비됐을
//   때만 '포인트 받기' 텍스트로 정확히 눌러 수령한다.
function claimTimerOnce(label) {
  var tag = label || "타이머";
  if (!ensureOnRewardsPage()) return;
  harvestDeadline = Date.now() + (cfg().timing.harvestBudgetMs || 480000);
  clearAllPopups("포인트 팝업");
  closeStickyBanner();
  scrollRewardsTop();
  var tc = findCard(cfg().texts.timerTitle, 4);
  if (!tc) { log(tag + ": 타이머 카드 없음 → 스킵"); return; }
  if (tapCardButton(tc.node, cfg().texts.pageClaim, tag + " 받기", true)) {
    sleep(cfg().timing.afterTapReward); collectPopup(); stat.cycles++;
    log(tag + " 수령 완료");
  } else {
    log(tag + ": '포인트 받기' 없음(쿨다운/이미 수령) → 스킵");
  }
  ensureOnRewardsPage(); closeStickyBanner();
}

// 종료 직전 1회 수확 (의뢰인 확정 2026-07-08 + 안정화 순서):
//  ① 타이머 받기(종료 1회분 — 시작 1회는 runFarm 초반 claimTimerOnce)
//  ② 좋아요 미션 '포인트 받기' — 시청 중 좋아요를 눌러뒀으므로 활성화돼 있음
//  ③ 출석체크 1차 — 광고류보다 먼저(광고가 Temu로 튕겨도 출석은 확보, 의뢰인: 출석 필수)
//  ④ 매일광고 '마무리 방문'(열리는 만큼) ⑤ '광고 보면 추가 보상' 1회
//  ⑥ 출석 재확인(보험 — 이미 받았으면 no-op)
function finalHarvest() {
  log("⏰ 마무리 수확: 타이머 → 좋아요 → 출석 → 매일광고 → 추가보상 → 출석확인");
  // 리워드 진입은 마무리 수확의 관문 — 진입만 성공하면 그 뒤 단계는 각자 실패해도 안전
  //  스킵되지만, 진입 자체가 실패하면 수확이 통째로 0이 된다. 광고(특히 Temu 전면광고)가
  //  화면을 잡고 있으면 진입이 실패할 수 있는데, 전면광고는 대개 수십 초 뒤 자동 종료되므로
  //  실패 시 '기다렸다' 재시도한다(최대 3회, 광고 자동종료 대기). 그래도 안 되면 무한 탭
  //  없이 깔끔히 포기(시청 크레딧은 이미 적립됨).
  var entered = ensureOnRewardsPage();
  for (var _r = 0; !entered && running && _r < 2; _r++) {
    log("리워드 진입 실패 → 8초 대기 후 재시도(" + (_r + 1) + "/2, 전면광고 자동종료 대기)");
    napChunked(8000, isRunningFlag);
    entered = ensureOnRewardsPage();
  }
  if (!entered) { log("리워드 진입 최종 실패 → 마무리 수확 생략(시청 크레딧은 적립됨)"); return; }
  harvestDeadline = Date.now() + (cfg().timing.harvestBudgetMs || 480000);
  clearAllPopups("포인트 팝업");
  closeStickyBanner();

  // ① 타이머 — 종료 시점 1회(시작 1회는 runFarm 초반에 수행)
  if (running) claimTimerOnce("마무리 타이머");

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

  // ③ 출석체크(1차) — ★ 광고류보다 '먼저' 수행(2026-07-06 3차 검증 + 의뢰인: 출석 필수).
  //   실측: 매일 광고가 'Temu 광고'인 경우가 있어, 시청 후 광고 랜딩이 외부 앱(Temu)을
  //   띄우면 리워드 페이지 복귀가 어려워짐. 위험이 적은 출석을 광고 '앞'에 두어,
  //   광고가 튕겨도 출석·타이머·좋아요는 이미 확보되게 한다.
  if (running) doAttendanceOnly();

  // ④ 매일광고 '마무리 방문' — 이번 방문에서 열리는 만큼 시청(시작 방문은 runFarm 초반).
  //   의뢰인 확정(2026-07-08): 시작·마무리 두 번만, 하루 한도 다 안 채움.
  if (running) {
    harvestDeadline = Date.now() + (cfg().timing.harvestBudgetMs || 480000);
    var nEnd = watchDailyAdBatch();
    log("매일광고 마무리 방문 완료(" + nEnd + "개)");
  }

  // ⑤ '광고 보면 추가 보상' 1회 — fail-safe: 카드 없으면 즉시 no-op,
  //   Temu 등 외부앱 튕김은 ensureOnRewardsPage가 무한루프 없이 정리한다.
  if (running) claimAdBonus();

  // ⑥ 출석 재확인(보험) — ③이 어떤 이유로든 누락됐어도 한 번 더 시도(의뢰인: 출석 꼭!).
  //   이미 받았으면 버튼이 없어 아무것도 안 누름(중복지급·오탭 없음).
  if (running) doAttendanceOnly();
}

// 최종 플로우(의뢰인 확정 2026-07-08, 5차 수정):
//   앱 실행 → 팝업 종료 → ★타이머 1회 수령(시작분) → ★매일광고 '시작 방문'(열리는 만큼)
//   → 첫 영상 좋아요 → 영상 시청만 쭉(60~100분 랜덤, 영상별 시간 랜덤, 광고영상 즉시 넘김)
//   → 포인트 페이지 1회 진입(finalHarvest: 타이머 종료분 → 좋아요 → 출석 →
//     매일광고 '마무리 방문' → 광고 추가보상 1회 → 출석 재확인) → 앱 종료.
// ※ 타이머·매일광고 모두 "시작 1번 + 종료 1번"만 — 20분마다 페이지 복귀는 봇 의심
//   우려로 의뢰인이 명시적으로 제외(2026-07-08). 매일광고는 세션 제한이 있어 방문당
//   열리는 만큼만 보게 되며(자동 종료), 하루 한도(40)를 다 채우지 않는 게 의도.
//   (레거시) 20분마다 '전체 수확' 반복은 config.harvestEveryCycle=true(기본 꺼짐).
function runFarm() {
  // 시청 시간: watchMin~Max 사이 랜덤(매일 같은 시간 = 봇 티, 의뢰인 확정 60~100분).
  var t = cfg().timing;
  var total = (t.watchMinMs && t.watchMaxMs && t.watchMaxMs >= t.watchMinMs)
    ? Math.round(rnd(t.watchMinMs, t.watchMaxMs))
    : (t.totalRunMs || (160 * 60 * 1000));
  log("[최종 플로우] 시작 타이머·광고 → 영상시청 " + Math.round(total / 60000) + "분(랜덤) → 종료 수확·출석");

  safe("실행", function () { ensureForeground(true); });          // 1. TikTok Lite 실행
  safe("팝업", function () { clearAllPopups("영상화면 팝업"); }); // 2. 영상화면 팝업 종료(출석팝업 ✕ 포함)

  // 3. 시작 시 타이머 1회 수령(전날/이전에 충전된 분)
  safe("시작타이머", function () { log("⏰ 시작 타이머 수령"); claimTimerOnce("시작 타이머"); });

  // 4. 매일광고 '시작 방문' — 이번 방문에서 열리는 만큼 시청(세션캡/한도에 닿으면 자동 종료)
  safe("시작광고", function () {
    if (!ensureOnRewardsPage()) { log("매일광고 시작 방문: 리워드 진입 실패 → 스킵"); return; }
    harvestDeadline = Date.now() + (cfg().timing.harvestBudgetMs || 480000);
    log("⏰ 매일광고 시작 방문");
    var n = watchDailyAdBatch();
    log("매일광고 시작 방문 완료(" + n + "개)");
  });

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
    // 기본: 5. 첫 영상 좋아요 → 6. 영상 시청만 쭉(중간에 포인트 페이지 안 감)
    safe("첫좋아요", function () {
      gotoFeed(); sleep(1500);
      // ★ 리워드 페이지도, 광고/랜딩(스턱)도, 전면광고도, 캡차도 아닐 때만 좋아요.
      //   (콜드 스타트가 전면광고/Temu 위로 뜨면 feedLike 좌표가 광고 CTA를 눌러 튕기는 것 방지)
      if (!exists(cfg().texts.pageMarker, 300) && !onStuckActivity() && !inAdScreen() && !detectCaptcha()) {
        tapRatio(cfg().coords.feedLike, "첫 영상 좋아요");        // 좋아요 미션 활성화
      } else {
        log("첫 영상 좋아요 보류 — 피드 영상이 아닌 화면(광고/리워드/캡차) 감지");
      }
    });
    safe("피드시청", function () { scrollFeedUntil(end); });      // 팝업 닫으며 끝까지 시청
  }

  // 시간이 만료되어 끝난 경우에만(사용자 정지가 아님) 마무리 단계 수행
  if (running) {
    safe("마무리수확", finalHarvest);    // 종료 수확: 타이머(종료분)→좋아요→출석→광고추가보상1회
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
