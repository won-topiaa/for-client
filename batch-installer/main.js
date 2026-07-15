/**
 * 배치 인스톨러 — 화면(UI) / 진입점
 * ==================================================================
 * 실행하면 전체화면 목록 UI가 뜬다.
 *   · 그룹별로 앱 목록이 카드로 보임
 *   · 각 앱 왼쪽 체크박스로 부분선택, 그룹 상단 [전체]로 전체선택/해제
 *   · 각 그룹 오른쪽 [⬇ 다운로드]를 누르면 그 그룹에서 "체크된 앱"을
 *     순서대로 플레이스토어에서 자동 검색·설치
 *   · [＋앱], [편집], [그룹＋], [저장] 으로 목록을 수시로 편집(기기에 저장됨)
 *
 * 준비물:
 *   1) AutoX.js 접근성 서비스 ON  (설치 버튼 자동 클릭에 필요)
 *   2) (선택) '다른 앱 위에 표시' 권한 — 진행 중 중지버튼 오버레이용
 * ------------------------------------------------------------------
 * 이건 초안(v0.1)입니다. 실제 갤럭시 기기에서 테스트하며
 * 타이밍/버튼 라벨(config.js)만 미세조정하면 됩니다.
 */
"ui";

var core = require("./core.js");
var C = require("./config.js");

// ── 목록 저장소(기기에 영구 저장) ────────────────────────────────
var store = storages.create("wontopia_batch_installer");

function loadGroups() {
  try {
    var raw = store.get("groups", null);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return JSON.parse(JSON.stringify(C.defaultGroups)); // 최초 실행: 공장 초기값
}
function saveGroups() {
  try {
    store.put("groups", JSON.stringify(model.groups));
    toast("저장되었습니다");
  } catch (e) { toast("저장 실패: " + e); }
}

// 화면 상태 모델 (checked 필드를 앱마다 추가)
var model = { groups: loadGroups() };
model.groups.forEach(function (g) {
  g.apps.forEach(function (a) { if (a.checked === undefined) a.checked = true; });
});

// ── 화면 레이아웃 ────────────────────────────────────────────────
ui.layout(
  <vertical>
    <appbar>
      <toolbar id="tb" title="배치 인스톨러" subtitle="원클릭 순차 설치 · 초안 v0.1"/>
    </appbar>
    <horizontal padding="8 6" bg="#f2f2f2">
      <button id="addGroup" text="＋그룹" style="Widget.AppCompat.Button.Borderless" textSize="13sp"/>
      <button id="save" text="💾저장" style="Widget.AppCompat.Button.Borderless" textSize="13sp"/>
      <button id="reset" text="공장초기화" style="Widget.AppCompat.Button.Borderless" textSize="13sp"/>
      <View layout_weight="1"/>
      <button id="runSelected" text="⬇ 선택 전체설치" bg="#2e7d32" textColor="#ffffff" textSize="13sp"/>
    </horizontal>
    <ScrollView layout_weight="1">
      <vertical id="groupContainer" padding="8"/>
    </ScrollView>
    <text id="statusBar" text="대기중 — 앱을 선택하고 [다운로드]를 누르세요" padding="10"
          bg="#212121" textColor="#a7d7a7" textSize="12sp" maxLines="4"/>
  </vertical>
);

core.setLogSink(function (line) {
  ui.run(function () { ui.statusBar.setText(line); });
});

// ── 플로팅 중지 오버레이 (플레이스토어 위에 떠 있는 중지 버튼) ────
// 설치가 시작되면 이 앱은 뒤로 가고 플레이스토어가 화면을 덮는다.
// 그래도 언제든 멈출 수 있도록 화면 위에 작은 [■ 중지] 버튼을 띄운다.
var stopWin = null;

function ensureOverlayPermission() {
  try {
    if (floaty.checkPermission && !floaty.checkPermission()) {
      toast("중지 버튼 표시를 위해 '다른 앱 위에 표시' 권한을 켜주세요");
      floaty.requestPermission();
      var t0 = Date.now();
      while (floaty.checkPermission && !floaty.checkPermission() && Date.now() - t0 < 30000) sleep(800);
    }
  } catch (e) {}
}

function showStopOverlay() {
  if (stopWin) return;
  try {
    stopWin = floaty.window(
      <horizontal id="bar" bg="#e6212121" padding="8" gravity="center_vertical">
        <vertical layout_weight="1">
          <text id="ov" text="설치 진행중…" textColor="#ffffff" textSize="12sp" maxLines="2"/>
          <text text="↔ 길게 눌러 이동 · 볼륨(-) 비상정지" textColor="#9e9e9e" textSize="9sp"/>
        </vertical>
        <button id="stopBtn" text="■ 중지" bg="#d32f2f" textColor="#ffffff" textSize="13sp" marginLeft="8"/>
      </horizontal>
    );
    stopWin.setPosition(30, 80);
    stopWin.stopBtn.click(function () {
      core.stop();
      toast("중지 요청 — 현재 앱만 마무리하고 정지합니다");
      try { ui.run(function () { stopWin.ov.setText("■ 중지 중…"); }); } catch (e) {}
    });
    // 오버레이 드래그 이동
    var dx = 0, dy = 0, wx = 0, wy = 0;
    stopWin.ov.setOnTouchListener(function (v, ev) {
      switch (ev.getAction()) {
        case ev.ACTION_DOWN:
          dx = ev.getRawX(); dy = ev.getRawY(); wx = stopWin.getX(); wy = stopWin.getY(); return true;
        case ev.ACTION_MOVE:
          stopWin.setPosition(Math.round(wx + ev.getRawX() - dx), Math.round(wy + ev.getRawY() - dy)); return true;
      }
      return true;
    });
  } catch (e) { toast("중지 오버레이 생성 실패(권한 확인): " + e); }
}

function setOverlayText(txt) {
  if (!stopWin) return;
  try { ui.run(function () { stopWin.ov.setText(txt); }); } catch (e) {}
}

function hideStopOverlay() {
  if (!stopWin) return;
  try { stopWin.close(); } catch (e) {}
  stopWin = null;
}

// ── 그룹/앱 카드 동적 렌더링 ─────────────────────────────────────
function render() {
  ui.groupContainer.removeAllViews();
  model.groups.forEach(function (g, gi) {
    var card = ui.inflate(
      <card w="*" margin="0 6" cardCornerRadius="8dp" cardElevation="2dp">
        <vertical padding="10">
          <horizontal gravity="center_vertical">
            <text text={g.name} textColor="#222222" textSize="15sp" textStyle="bold" layout_weight="1"/>
            <button id="selAll" text="전체" style="Widget.AppCompat.Button.Borderless" textSize="12sp" minWidth="0" padding="6 0"/>
            <button id="addApp" text="＋앱" style="Widget.AppCompat.Button.Borderless" textSize="12sp" minWidth="0" padding="6 0"/>
            <button id="editGroup" text="편집" style="Widget.AppCompat.Button.Borderless" textSize="12sp" minWidth="0" padding="6 0"/>
            <button id="dl" text="⬇ 다운로드" bg="#1565c0" textColor="#ffffff" textSize="12sp" minWidth="0" padding="10 4"/>
          </horizontal>
          <vertical id="appList" marginTop="4"/>
        </vertical>
      </card>,
      ui.groupContainer, false);

    // 앱 행들
    g.apps.forEach(function (a, ai) {
      var row = ui.inflate(
        <horizontal gravity="center_vertical" padding="2 4">
          <checkbox id="cb" checked={!!a.checked}/>
          <text id="nm" text={a.name + (a.pkg ? "  (" + a.pkg + ")" : "")} textColor="#333333" textSize="14sp" layout_weight="1" marginLeft="4"/>
          <text id="st" text="" textColor="#888888" textSize="11sp" marginRight="6"/>
          <text id="del" text="🗑" textSize="14sp" padding="6"/>
        </horizontal>,
        card.appList, false);

      a._stView = row.st; // 진행상태 표시용 참조 저장
      row.cb.setOnCheckedChangeListener(function (v, checked) { a.checked = checked; });
      row.del.click(function () {
        g.apps.splice(ai, 1); render();
      });
      card.appList.addView(row);
    });

    // 그룹 버튼 동작
    card.selAll.click(function () {
      var allChecked = g.apps.every(function (a) { return a.checked; });
      g.apps.forEach(function (a) { a.checked = !allChecked; });
      render();
    });
    card.addApp.click(function () {
      dialogs.rawInput("추가할 앱 이름 (선택: 이름|패키지명)", "").then(function (val) {
        if (!val) return;
        var parts = String(val).split("|");
        var item = { name: parts[0].trim(), checked: true };
        if (parts[1]) item.pkg = parts[1].trim();
        g.apps.push(item); render();
      });
    });
    card.editGroup.click(function () {
      dialogs.rawInput("그룹 이름 수정 (비우고 확인 시 그룹 삭제)", g.name).then(function (val) {
        if (val === null) return;
        if (String(val).trim() === "") { model.groups.splice(gi, 1); }
        else { g.name = String(val).trim(); }
        render();
      });
    });
    card.dl.click(function () { startInstall(g.apps.filter(function (a) { return a.checked; }), g.name); });

    ui.groupContainer.addView(card);
  });
}

// ── 설치 실행 ────────────────────────────────────────────────────
var worker = null;
function startInstall(apps, label) {
  if (core.isRunning()) { toast("이미 설치가 진행 중입니다"); return; }
  if (!apps || apps.length === 0) { toast("선택된 앱이 없습니다"); return; }

  var names = apps.map(function (a) { return a.name; }).join(", ");
  dialogs.confirm("설치 시작", "[" + (label || "선택") + "] " + apps.length + "개 앱을 순서대로 설치합니다.\n\n" + names + "\n\n진행할까요?")
    .then(function (ok) {
      if (!ok) return;
      ensureOverlayPermission();
      showStopOverlay();
      setOverlayText("설치 준비중… (0/" + apps.length + ")");
      toast("설치 시작 — 화면에서 손을 떼고 지켜봐 주세요");
      worker = threads.start(function () {
        core.installList(apps, function (i, total, name, phase, result) {
          if (phase === "start") setOverlayText("(" + (i + 1) + "/" + total + ") " + name + " 설치중…");
          if (phase === "finished") {
            var s = result;
            hideStopOverlay();
            ui.run(function () {
              ui.statusBar.setText("완료 · 설치 " + s.installed + " / 업데이트 " + s.updated +
                " / 이미있음 " + s.already + " / 건너뜀 " + s.skipped + " / 실패 " + s.failed);
              toast("모든 설치 작업 완료");
            });
          }
        });
      });
    });
}

// ── 상단 버튼 동작 ───────────────────────────────────────────────
ui.addGroup.click(function () {
  dialogs.rawInput("새 그룹 이름", "새 그룹").then(function (val) {
    if (!val) return;
    model.groups.push({ name: String(val).trim(), apps: [] }); render();
  });
});
ui.save.click(saveGroups);
ui.reset.click(function () {
  dialogs.confirm("공장 초기화", "편집한 목록을 버리고 기본 목록으로 되돌립니다. 진행할까요?").then(function (ok) {
    if (!ok) return;
    store.remove("groups");
    model.groups = loadGroups();
    model.groups.forEach(function (g) { g.apps.forEach(function (a) { a.checked = true; }); });
    render(); toast("기본 목록으로 초기화됨");
  });
});
ui.runSelected.click(function () {
  // 모든 그룹에서 체크된 앱을 한 번에(중복 이름은 제거)
  var seen = {}, all = [];
  model.groups.forEach(function (g) {
    g.apps.forEach(function (a) {
      if (a.checked && !seen[a.name]) { seen[a.name] = 1; all.push(a); }
    });
  });
  startInstall(all, "선택 전체");
});

// 뒤로가기로 종료 시 진행 중이면 중지
ui.emitter.on("back_pressed", function () { try { core.stop(); } catch (e) {} });

// 비상 정지: 볼륨(-) 키 — 플레이스토어 화면에서도 언제든 멈춤
try {
  events.observeKey();
  events.onKeyDown("volume_down", function () {
    if (core.isRunning()) { core.stop(); toast("비상 정지(볼륨-)"); }
  });
} catch (e) {}

// 스크립트 종료 시 오버레이/설치 정리(웨이크락·창 누수 방지)
try {
  events.on("exit", function () {
    try { core.stop(); } catch (e) {}
    try { hideStopOverlay(); } catch (e) {}
  });
} catch (e) {}

// 접근성 서비스 안내(꺼져 있으면 켜기 유도)
if (!auto.service) {
  toast("설치 자동화를 위해 AutoX.js 접근성 서비스를 켜주세요");
}

render();
