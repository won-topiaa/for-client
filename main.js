/**
 * TikTok Lite 포인트 파머 — 진입점 (플로팅 제어판)
 * ------------------------------------------------------------------
 * 실행하면 화면 위에 작은 제어판이 뜹니다.
 *   [시작]     : 자동 파밍 시작 (farm 모드면 켜두는 동안 계속 적립)
 *   [정지]     : 중지  (볼륨(-) 버튼으로도 비상 정지 가능)
 *   [좌표설정] : 화면을 탭해서 버튼 위치를 잡음(최초 1회 필수)
 *   [접기]     : 제어판을 작게
 *
 * 준비물:
 *   1) AutoX.js 접근성 서비스 ON  (없으면 실행 시 설정 화면이 열림)
 *   2) "다른 앱 위에 표시(오버레이)" 권한 ON (없으면 요청 화면이 열림)
 */
"use strict";

// ── 권한 확보 ────────────────────────────────────────────────
auto.waitFor(); // 접근성 서비스 대기(꺼져 있으면 설정 열림)

// 오버레이 권한(버전에 따라 API 없을 수 있어 try로 감쌈)
try {
  if (floaty.checkPermission && !floaty.checkPermission()) {
    toast("'다른 앱 위에 표시' 권한을 허용해주세요");
    floaty.requestPermission();
    // 사용자가 허용하고 돌아올 시간
    while (floaty.checkPermission && !floaty.checkPermission()) sleep(1000);
  }
} catch (e) {}

var core = require("./core.js");

// ── 플로팅 제어판 ────────────────────────────────────────────
var collapsed = false;

var win = floaty.window(
  <vertical id="panel" bg="#e61c1c1e" padding="10" w="190">
    <horizontal>
      <text id="title" text="≡ TTL 포인트 파머" textColor="#ffffff" textSize="13sp" textStyle="bold" layout_weight="1"/>
    </horizontal>
    <text id="status" text="● 대기중" textColor="#ffcc66" textSize="11sp" marginTop="4"/>
    <horizontal marginTop="6">
      <button id="start" text="시작" w="82" h="42" textSize="12sp"/>
      <button id="stop" text="정지" w="82" h="42" textSize="12sp" marginLeft="6"/>
    </horizontal>
    <horizontal marginTop="6">
      <button id="cal" text="좌표설정" w="82" h="42" textSize="12sp"/>
      <button id="fold" text="접기" w="82" h="42" textSize="12sp" marginLeft="6"/>
    </horizontal>
    <text id="log" text="준비됨" textColor="#a7d7a7" textSize="9sp" maxLines="3" marginTop="6"/>
  </vertical>
);
win.setPosition(40, 200);

var V_VISIBLE = 0, V_GONE = 8; // android.view.View.VISIBLE / GONE

function setStatus(txt, color) {
  ui.run(function () {
    win.status.setText(txt);
    win.status.setTextColor(colors.parseColor(color));
  });
}

// 로그를 제어판에 표시
core.setLogSink(function (line) {
  try { ui.run(function () { win.log.setText(line); }); } catch (e) {}
});

// ── 버튼 동작 ────────────────────────────────────────────────
win.start.click(function () {
  core.start();
  setStatus("● 실행중", "#66dd66");
});
win.stop.click(function () {
  core.stop();
  setStatus("● 정지", "#ffcc66");
});
win.cal.click(function () {
  if (core.isRunning()) { toast("먼저 [정지] 후 좌표설정하세요"); return; }
  toast("화면 안내대로 각 버튼 위치를 탭하세요");
  core.calibrate();
});
win.fold.click(function () {
  collapsed = !collapsed;
  ui.run(function () {
    win.status.setVisibility(collapsed ? V_GONE : V_VISIBLE);
    win.log.setVisibility(collapsed ? V_GONE : V_VISIBLE);
    win.cal.setVisibility(collapsed ? V_GONE : V_VISIBLE);
    win.stop.setVisibility(collapsed ? V_GONE : V_VISIBLE);
    win.fold.setText(collapsed ? "펼치기" : "접기");
  });
});

// ── 제어판 드래그 이동(타이틀을 잡고 끌기) ───────────────────
var dx = 0, dy = 0, wx = 0, wy = 0;
win.title.setOnTouchListener(function (v, ev) {
  switch (ev.getAction()) {
    case ev.ACTION_DOWN:
      dx = ev.getRawX(); dy = ev.getRawY(); wx = win.getX(); wy = win.getY(); return true;
    case ev.ACTION_MOVE:
      win.setPosition(Math.round(wx + ev.getRawX() - dx), Math.round(wy + ev.getRawY() - dy)); return true;
  }
  return true;
});

// ── 비상 정지: 볼륨(-) 키 ────────────────────────────────────
try {
  events.observeKey();
  events.onKeyDown("volume_down", function () {
    core.stop();
    setStatus("● 정지(볼륨-)", "#ff8866");
    toast("비상 정지");
  });
} catch (e) {
  core.log("볼륨키 감지 불가(무시해도 됨): " + e);
}

// ── 상태 주기 갱신 + 스크립트 유지 ───────────────────────────
setInterval(function () {
  try {
    if (!core.isRunning()) return;
    ui.run(function () { win.status.setText("● 실행중"); });
  } catch (e) {}
}, 5000);

core.log("제어판 준비 완료. 최초 1회 [좌표설정] 후 [시작]. 비상정지 = 볼륨(-)");
