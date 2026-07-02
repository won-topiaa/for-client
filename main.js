/**
 * TikTok Lite 자동 포인트 적립 스크립트 (AutoX.js + 접근성 서비스)
 * ------------------------------------------------------------------
 * 실행 전 준비:
 *   1) AutoX.js 앱 설치
 *   2) AutoX.js 접근성 서비스 ON (설정 > 접근성 > AutoX.js)
 *   3) config.js를 자기 폰에 맞게 보정
 *   4) 이 파일을 AutoX.js에서 실행 (원클릭: 홈 화면 바로가기/위젯으로 등록 가능)
 *
 * 동작 흐름(의뢰인 요청 1~12):
 *   1. TikTok Lite 실행
 *   2. 영상 화면 팝업(출석체크/이벤트) 종료
 *   3. 우측 중간 하트 누르기 → 지정 시간만큼 스크롤 시청(중간 팝업 자동 닫기)
 *   4. 좌측 하단 두번째 포인트 버튼 누르기
 *   5. 포인트 화면의 (이벤트)팝업 종료
 *   6. 20분마다 타이머 → 받기
 *   7. 광고보기
 *   8. 30초 대기 후 좌측 상단 p 누르기
 *   9. 상/하단 영상 좋아요 → 메뉴 받기
 *  10. 뒤로가기
 *  11. 출석체크 누르기
 *  12. 앱 종료
 *
 * 반복: config.maxCycles == 1 이면 1~12 한 바퀴. 2 이상이면 6~10을
 *       20분 간격으로 반복한 뒤 11~12로 마무리.
 */

"use strict";

var CONFIG = require("./config.js");

// ── 접근성 서비스 확보 ───────────────────────────────────────
auto.waitFor();
var W = device.width;
var H = device.height;

// ── 공용 헬퍼 ────────────────────────────────────────────────

/** 로그 + 화면 토스트 */
function log(msg) {
  console.log("[TTL] " + msg);
  toastLog(msg);
}

/** 비율 좌표를 실제 픽셀로 눌러줌 */
function tapRatio(ratio, label) {
  var x = Math.round(ratio.x * W);
  var y = Math.round(ratio.y * H);
  log((label || "탭") + " → (" + x + ", " + y + ")");
  click(x, y);
  sleep(CONFIG.timing.shortWait);
}

/**
 * 텍스트 후보들 중 하나라도 화면에 보이면 눌러줌.
 * @param timeoutMs 첫 후보 탐색 대기(기본 config 값)
 * @return 성공하면 true, 못 찾으면 false
 */
function tapText(textList, label, timeoutMs) {
  var t0 = (timeoutMs === undefined) ? CONFIG.retry.findTimeoutMs : timeoutMs;
  for (var i = 0; i < textList.length; i++) {
    var t = textList[i];
    var node = text(t).findOne(t0)
            || textContains(t).findOne(300)
            || desc(t).findOne(300);
    if (node) {
      log((label || "텍스트") + " '" + t + "' 클릭");
      clickNode(node);
      sleep(CONFIG.timing.shortWait);
      return true;
    }
  }
  return false;
}

/** 노드를 클릭(자체 clickable 아니면 좌표로 폴백) */
function clickNode(node) {
  if (node.click()) return true;
  var b = node.bounds();
  click(b.centerX(), b.centerY());
  return true;
}

/**
 * 텍스트로 먼저 시도, 실패하면 좌표로 폴백.
 * @return true = 무언가 눌렀음
 */
function tapTextOrCoord(textList, coordRatio, label) {
  if (textList && tapText(textList, label)) return true;
  if (coordRatio) {
    tapRatio(coordRatio, label + "(좌표)");
    return true;
  }
  log(label + " 실패: 대상을 못 찾음");
  return false;
}

/** 확정적 팝업 닫기: 닫기 텍스트 → 좌표 X 순으로 시도 */
function closePopup(label) {
  if (tapText(CONFIG.texts.close, (label || "팝업") + " 닫기")) {
    sleep(CONFIG.timing.afterPopupClose);
    return true;
  }
  tapRatio(CONFIG.coords.popupClose, (label || "팝업") + " X버튼");
  sleep(CONFIG.timing.afterPopupClose);
  return true;
}

/**
 * 시청 중 팝업 처리: 오탭 방지를 위해 텍스트 기반으로만 닫음(좌표 폴백 없음).
 * 팝업이 없으면 아무것도 안 함.
 */
function checkAndClosePopup() {
  if (tapText(CONFIG.texts.close, "시청중 팝업", 300)) {
    sleep(CONFIG.timing.afterPopupClose);
    return true;
  }
  return false;
}

/** 화면을 위로 스와이프해 다음 영상으로 넘김 */
function swipeToNextVideo() {
  var x = Math.round(W * 0.5);
  var y1 = Math.round(H * 0.75);
  var y2 = Math.round(H * 0.25);
  swipe(x, y1, x, y2, 400);
  sleep(800);
}

// ── 단계별 동작 ──────────────────────────────────────────────

/** 1. TikTok Lite 실행 */
function launchTikTokLite() {
  if (app.launchApp(CONFIG.appName)) {
    log("이름으로 앱 실행: " + CONFIG.appName);
  } else {
    var launched = false;
    for (var i = 0; i < CONFIG.packageCandidates.length; i++) {
      if (app.launchPackage(CONFIG.packageCandidates[i])) {
        log("패키지로 앱 실행: " + CONFIG.packageCandidates[i]);
        launched = true;
        break;
      }
    }
    if (!launched) {
      log("앱 실행 실패! config.js의 appName/packageCandidates 확인 필요");
      exit();
    }
  }
  sleep(CONFIG.timing.afterLaunch);
}

/** 3. 지정 시간만큼 영상 스크롤 시청(중간 팝업 자동 닫기) */
function watchVideos(durationMs) {
  var secs = Math.round(durationMs / 1000);
  log("영상 시청 시작: " + secs + "초 동안 스크롤 시청");
  var start = Date.now();
  while (Date.now() - start < durationMs) {
    sleep(CONFIG.timing.scrollIntervalMs); // 현재 영상 시청
    checkAndClosePopup();                   // 시청 중 팝업 처리
    swipeToNextVideo();                     // 다음 영상으로
  }
  log("영상 시청 종료");
}

/** 2~3. 초기 세팅(팝업닫기 → 하트 → 시청) */
function initialSetup() {
  closePopup("영상화면(출석/이벤트)");                 // 2
  tapRatio(CONFIG.coords.heart, "우측중간 하트");       // 3-a
  watchVideos(CONFIG.timing.watchDurationMs);          // 3-b
}

/** 4~5. 포인트 버튼 → 포인트 화면 팝업 종료 */
function openPointScreen() {
  tapRatio(CONFIG.coords.pointButton, "포인트 버튼");   // 4
  closePopup("포인트(이벤트)");                         // 5
}

/** 6~10. 포인트 적립 사이클 */
function claimCycle() {
  log("=== 포인트 적립 사이클 시작 ===");

  // 6. 타이머 → 받기
  tapTextOrCoord(CONFIG.texts.timer, CONFIG.coords.timer, "타이머");
  tapText(CONFIG.texts.receive, "받기");

  // 7. 광고보기
  if (!tapText(CONFIG.texts.watchAd, "광고보기")) {
    log("광고보기 버튼 없음 → 이번 사이클 광고 스킵");
    return;
  }

  // 8. 30초 대기 후 좌측 상단 p
  log("광고 재생 30초 대기...");
  sleep(CONFIG.timing.afterAdWatch);
  tapRatio(CONFIG.coords.topLeftP, "좌측상단 p");

  // 9. 영상 좋아요 → 받기
  tapRatio(CONFIG.coords.videoLike, "영상 좋아요");
  sleep(CONFIG.timing.shortWait);
  tapText(CONFIG.texts.receive, "받기");

  // 10. 뒤로가기
  back();
  sleep(CONFIG.timing.shortWait);
  log("=== 사이클 완료 ===");
}

/** 11. 출석체크 */
function attendanceCheck() {
  tapTextOrCoord(CONFIG.texts.attendance, CONFIG.coords.attendanceCheck, "출석체크");
}

/** 12. 앱 종료(백그라운드로 내림; 완전 강제종료는 루팅 필요) */
function closeApp() {
  log("앱 종료(홈으로)");
  home();
  sleep(CONFIG.timing.shortWait);
}

// ── 메인 플로우 ──────────────────────────────────────────────
function main() {
  log("TikTok Lite 자동화 시작 (화면: " + W + "x" + H + ")");

  launchTikTokLite();   // 1
  initialSetup();       // 2~3
  openPointScreen();    // 4~5

  var cycles = Math.max(1, CONFIG.maxCycles);
  for (var c = 1; c <= cycles; c++) {
    log("사이클 " + c + "/" + cycles);
    claimCycle();       // 6~10
    if (c < cycles) {
      var mins = Math.round(CONFIG.timing.betweenCycleMs / 60000);
      log(mins + "분 대기 후 다음 사이클...");
      sleep(CONFIG.timing.betweenCycleMs);
    }
  }

  attendanceCheck();    // 11
  closeApp();           // 12
  log("전체 플로우 완료");
}

main();
