/**
 * 배치 인스톨러 — 설치 엔진 (core)
 * ==================================================================
 * 역할: 앱 목록을 받아 하나씩 순서대로
 *        플레이스토어 열기 → (검색/직접이동) → [설치] 자동 탭 →
 *        설치 완료 감지 → 다음 앱  을 수행한다.
 *
 * ※ 이 파일은 UI를 모른다. main.js가 목록을 넘겨주고, 진행상황은
 *   콜백(onProgress)으로 돌려준다. UI 갱신은 main.js가 담당.
 *
 * ※ 접근성 서비스(auto)가 켜져 있어야 [설치] 버튼을 자동 클릭할 수 있다.
 * ------------------------------------------------------------------
 * 주의(초안): 플레이스토어 UI는 버전/기기/언어에 따라 조금씩 다르다.
 *   실제 기기에서 1~2회 돌려보며 labels(config.js)만 맞추면
 *   대부분 그대로 동작한다. 좌표가 아니라 "버튼 글자"로 잡기 때문에
 *   해상도가 달라도 비교적 안전하다.
 */
"use strict";

var C = require("./config.js");

var _stop = false;          // 중지 요청 플래그
var _running = false;
var _log = function () {};  // main.js가 주입

function setLogSink(fn) { if (typeof fn === "function") _log = fn; }
function isRunning() { return _running; }
function stop() { _stop = true; }

function ts() {
  var d = new Date();
  function p(n) { return (n < 10 ? "0" : "") + n; }
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
function log(msg) {
  var line = "[" + ts() + "] " + msg;
  try { _log(line); } catch (e) {}
  try { console.log(line); } catch (e) {}
}

// ── 접근성 노드 유틸 ─────────────────────────────────────────────
// 텍스트 목록 중 하나라도 "포함"하는 클릭 가능 노드를 찾는다.
function findByLabels(labels, timeoutMs) {
  var t0 = Date.now();
  do {
    for (var i = 0; i < labels.length; i++) {
      var n = textContains(labels[i]).findOnce() || descContains(labels[i]).findOnce();
      if (n) return n;
    }
    sleep(200);
  } while (Date.now() - t0 < (timeoutMs || 0));
  return null;
}

function existsLabel(labels) {
  for (var i = 0; i < labels.length; i++) {
    if (textContains(labels[i]).exists() || descContains(labels[i]).exists()) return true;
  }
  return false;
}

// 노드를 안전하게 클릭(자체 클릭 → 안되면 좌표 클릭)
function clickNode(node) {
  if (!node) return false;
  try {
    if (node.click()) return true;
    var b = node.bounds();
    if (b) { click(b.centerX(), b.centerY()); return true; }
  } catch (e) {}
  return false;
}

// 클릭 가능한 조상까지 올라가며 클릭(검색결과 카드처럼 글자만 있고
// 클릭은 부모가 받는 경우 대비)
function clickNodeOrParent(node) {
  var n = node;
  for (var i = 0; i < 6 && n; i++) {
    try { if (n.clickable() && n.click()) return true; } catch (e) {}
    try { n = n.parent(); } catch (e) { break; }
  }
  return clickNode(node); // 마지막엔 좌표 클릭
}

// 중지 신호를 반영하며 자는 함수
function napChunked(ms) {
  var end = Date.now() + ms;
  while (Date.now() < end) {
    if (_stop) return;
    sleep(Math.min(300, end - Date.now()));
  }
}

// ── 플레이스토어 진입 ────────────────────────────────────────────
function openStoreSearch(appName) {
  app.startActivity({
    action: "android.intent.action.VIEW",
    data: "market://search?q=" + encodeURIComponent(appName) + "&c=apps",
    packageName: C.storedPackage,
  });
}

function openStoreDetail(pkg) {
  app.startActivity({
    action: "android.intent.action.VIEW",
    data: "market://details?id=" + pkg,
    packageName: C.storedPackage,
  });
}

// 검색 결과 페이지에서 앱 이름과 가장 잘 맞는 결과를 눌러 상세로 진입
function tapFirstSearchResult(appName) {
  sleep(C.timing.afterSearch);
  // 1순위: 앱 이름 텍스트가 그대로 보이면 그 카드 클릭
  var hit = textContains(appName).findOnce() || descContains(appName).findOnce();
  if (hit) { clickNodeOrParent(hit); return true; }
  // 2순위: 검색결과 리스트의 첫 항목 클릭(대략 상단 카드)
  var list = className("androidx.recyclerview.widget.RecyclerView").findOnce()
          || className("android.widget.ListView").findOnce();
  if (list) {
    var b = list.bounds();
    click(b.centerX(), b.top + Math.round(b.height() * 0.18));
    return true;
  }
  return false;
}

// ── 상세페이지에서 설치 처리 ─────────────────────────────────────
// 반환: "installed"(새로설치완료) | "updated" | "already"(이미최신) |
//       "skip_incompatible" | "timeout" | "fail"
function installFromDetailPage(appName) {
  sleep(C.timing.afterOpenDetail);

  // 설치 불가(호환 안 됨) 먼저 확인
  if (existsLabel(C.labels.incompatible)) {
    log("⚠ " + appName + " — 이 기기와 호환되지 않음, 건너뜀");
    return "skip_incompatible";
  }

  // 이미 최신 설치 상태? ([열기]는 있고 [업데이트]는 없음)
  if (existsLabel(C.labels.open) && !existsLabel(C.labels.update) && !existsLabel(C.labels.install)) {
    log("✓ " + appName + " — 이미 설치되어 있음(최신), 건너뜀");
    return "already";
  }

  // [설치] 또는 [업데이트] 버튼 클릭
  var isUpdate = existsLabel(C.labels.update) && !existsLabel(C.labels.install);
  var btnLabels = isUpdate ? C.labels.update : C.labels.install;
  var btn = findByLabels(btnLabels, 5000);
  if (!btn) {
    log("✗ " + appName + " — 설치/업데이트 버튼을 못 찾음");
    return "fail";
  }
  clickNode(btn);
  log((isUpdate ? "↻ 업데이트 시작: " : "▼ 설치 시작: ") + appName);

  // 완료 대기: [열기]가 나타나거나 [설치/업데이트]가 사라지면 완료로 간주
  var t0 = Date.now();
  while (Date.now() - t0 < C.timing.installTimeout) {
    if (_stop) { log("■ 중지 요청 — 설치 대기 중단"); return "fail"; }
    // 완료 신호
    if (existsLabel(C.labels.open) && !existsLabel(C.labels.cancel)) {
      log((isUpdate ? "✔ 업데이트 완료: " : "✔ 설치 완료: ") + appName);
      return isUpdate ? "updated" : "installed";
    }
    napChunked(C.timing.clickPoll);
  }
  log("⏱ " + appName + " — 설치 시간 초과(다음 앱으로)");
  return "timeout";
}

// ── 앱 1개 처리 ──────────────────────────────────────────────────
function installOne(appItem) {
  var name = appItem.name;
  log("── " + name + " 처리 시작 ──");

  if (appItem.pkg) {
    openStoreDetail(appItem.pkg);
    sleep(C.timing.afterOpenStore);
  } else {
    openStoreSearch(name);
    sleep(C.timing.afterOpenStore);
    if (!tapFirstSearchResult(name)) {
      log("✗ " + name + " — 검색 결과를 찾지 못함");
      return "fail";
    }
  }
  return installFromDetailPage(name);
}

// ── 목록 전체 순차 설치(메인 진입점) ─────────────────────────────
// apps: [{name, pkg?}, ...]
// onProgress(index, total, appName, phase, resultCode)
function installList(apps, onProgress) {
  _stop = false;
  _running = true;
  var summary = { installed: 0, updated: 0, already: 0, skipped: 0, failed: 0 };

  try {
    if (!auto.service) {
      log("‼ 접근성 서비스가 꺼져 있습니다. 설정에서 켜주세요.");
      auto.waitFor();
    }
    for (var i = 0; i < apps.length; i++) {
      if (_stop) { log("■ 사용자 중지 — 남은 앱 취소"); break; }
      var appItem = apps[i];
      try { onProgress && onProgress(i, apps.length, appItem.name, "start", null); } catch (e) {}

      var r = installOne(appItem);

      if (r === "installed") summary.installed++;
      else if (r === "updated") summary.updated++;
      else if (r === "already") summary.already++;
      else if (r === "skip_incompatible") summary.skipped++;
      else summary.failed++;

      try { onProgress && onProgress(i, apps.length, appItem.name, "done", r); } catch (e) {}
      napChunked(C.timing.betweenApps);
    }
  } catch (e) {
    log("‼ 오류: " + e);
  } finally {
    _running = false;
    home(); // 끝나면 홈으로
    log("=== 완료 · 설치 " + summary.installed + " / 업데이트 " + summary.updated +
        " / 이미있음 " + summary.already + " / 건너뜀 " + summary.skipped +
        " / 실패 " + summary.failed + " ===");
    try { onProgress && onProgress(apps.length, apps.length, "", "finished", summary); } catch (e) {}
  }
  return summary;
}

module.exports = {
  setLogSink: setLogSink,
  installList: installList,
  stop: stop,
  isRunning: isRunning,
  log: log,
};
