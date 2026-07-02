/**
 * TikTok Lite 자동 포인트 적립 스크립트 (AutoX.js + 접근성 서비스)
 * ------------------------------------------------------------------
 * 실행 전 준비:
 *   1) AutoX.js 앱 설치
 *   2) AutoX.js 접근성 서비스 ON (설정 > 접근성 > AutoX.js)
 *   3) config.js를 자기 폰에 맞게 보정
 *   4) 이 파일을 AutoX.js에서 실행
 *
 * 동작 흐름(요청 사항):
 *   1. TikTok Lite 실행
 *   2. 영상 화면 팝업 종료
 *   3. 우측 중간 하트 누르기
 *   4. 15초 대기 후 좌측 하단 두번째 포인트 버튼 누르기
 *   5. 새 팝업 종료
 *   6. 20분마다: 타이머 → 받기
 *   7. 광고보기
 *   8. 30초 대기 후 우측 상단 p 누르기
 *   9. 상/하단 영상 좋아요 → 메뉴 받기
 *  10. 뒤로가기
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
 * 성공하면 true, 못 찾으면 false.
 */
function tapText(textList, label) {
  for (var i = 0; i < textList.length; i++) {
    var t = textList[i];
    // 완전일치 우선, 없으면 부분일치
    var node = text(t).findOne(CONFIG.retry.findTimeoutMs)
            || textContains(t).findOne(500)
            || desc(t).findOne(500);
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

/** 팝업 닫기: 닫기 텍스트 → 좌표 X → 뒤로가기 순으로 시도 */
function closePopup(label) {
  if (tapText(CONFIG.texts.close, (label || "팝업") + " 닫기")) {
    sleep(CONFIG.timing.afterPopupClose);
    return true;
  }
  tapRatio(CONFIG.coords.popupClose, (label || "팝업") + " X버튼");
  sleep(CONFIG.timing.afterPopupClose);
  return true;
}

// ── 단계별 동작 ──────────────────────────────────────────────

/** 1. TikTok Lite 실행 */
function launchTikTokLite() {
  // 이름으로 먼저 시도
  if (app.launchApp(CONFIG.appName)) {
    log("이름으로 앱 실행: " + CONFIG.appName);
  } else {
    // 패키지 후보로 시도
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

/** 2~5. 초기 세팅(팝업닫기 → 하트 → 15초 → 포인트버튼 → 팝업닫기) */
function initialSetup() {
  closePopup("영상화면");                              // 2
  tapRatio(CONFIG.coords.heart, "우측중간 하트");        // 3
  log("15초 대기...");
  sleep(CONFIG.timing.beforePointBtn);                 // 4 대기
  tapRatio(CONFIG.coords.pointButton, "포인트 버튼");    // 4
  closePopup("포인트");                                 // 5
}

/** 6~10. 20분마다 반복하는 포인트 적립 사이클 */
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

  // 8. 30초 대기 후 우측 상단 p
  log("광고 재생 30초 대기...");
  sleep(CONFIG.timing.afterAdWatch);
  tapRatio(CONFIG.coords.topRightP, "우측상단 p");

  // 9. 영상 좋아요 → 받기
  tapRatio(CONFIG.coords.videoLike, "영상 좋아요");
  sleep(CONFIG.timing.shortWait);
  tapText(CONFIG.texts.receive, "받기");

  // 10. 뒤로가기
  back();
  sleep(CONFIG.timing.shortWait);
  log("=== 사이클 완료 ===");
}

// ── 메인 루프 ────────────────────────────────────────────────
function main() {
  log("TikTok Lite 자동화 시작 (화면: " + W + "x" + H + ")");

  launchTikTokLite();  // 1
  initialSetup();      // 2~5

  // 6~10을 20분마다 반복
  while (true) {
    claimCycle();
    var mins = Math.round(CONFIG.timing.loopIntervalMs / 60000);
    log(mins + "분 대기 후 다음 사이클...");
    sleep(CONFIG.timing.loopIntervalMs);
  }
}

main();
