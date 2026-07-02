/**
 * TikTok Lite 포인트 파머 — 진입점 (플로팅 제어판)
 * ------------------------------------------------------------------
 * 실행하면 화면 위에 작은 제어판이 뜹니다.
 *   [시작]     : 자동 파밍 시작 (config.mode = farm 이면 켜두면 계속 적립)
 *   [정지]     : 중지
 *   [좌표설정] : 화면을 탭해서 버튼 위치를 잡음(최초 1회 필수)
 *   [접기]     : 제어판을 작게
 *
 * 준비물:
 *   1) AutoX.js 접근성 서비스 ON
 *   2) "다른 앱 위에 표시(오버레이)" 권한 ON
 */
"use strict";

auto.waitFor(); // 접근성 서비스 대기

var core = require("./core.js");

// 오버레이 권한 확인
if (typeof floaty === "undefined") {
  toast("이 기기는 플로팅 창을 지원하지 않습니다");
  exit();
}

var collapsed = false;

var win = floaty.window(
  <vertical id="panel" bg="#e61c1c1e" padding="10" w="190">
    <horizontal>
      <text id="title" text="TTL 포인트 파머" textColor="#ffffff" textSize="13sp" textStyle="bold" layout_weight="1"/>
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

// 로그를 제어판에 표시
core.setLogSink(function (line) {
  try { ui.run(function () { win.log.setText(line); }); } catch (e) {}
});

// 버튼 동작
win.start.click(function () {
  core.start();
  ui.run(function () { win.status.setText("● 실행중"); win.status.setTextColor(colors.parseColor("#66dd66")); });
});
win.stop.click(function () {
  core.stop();
  ui.run(function () { win.status.setText("● 정지"); win.status.setTextColor(colors.parseColor("#ffcc66")); });
});
win.cal.click(function () {
  toast("화면 안내대로 각 버튼 위치를 탭하세요");
  core.calibrate();
});
win.fold.click(function () {
  collapsed = !collapsed;
  ui.run(function () {
    win.status.attr("visibility", collapsed ? "gone" : "visible");
    win.log.attr("visibility", collapsed ? "gone" : "visible");
    win.fold.setText(collapsed ? "펼치기" : "접기");
  });
});

// 제어판 드래그 이동
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

// 상태 주기적 갱신 + 스크립트 유지
setInterval(function () {
  try {
    ui.run(function () {
      if (core.isRunning()) { win.status.setText("● 실행중"); }
    });
  } catch (e) {}
}, 5000);

core.log("제어판 준비 완료. [좌표설정] 먼저 1회 진행 후 [시작] 하세요.");
