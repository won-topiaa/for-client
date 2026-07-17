/* 라이트/다크 수동 전환 (헤더 중앙 딸깍 버튼)
 *
 * CSP(script-src 'self')상 인라인 스크립트를 쓸 수 없으므로 이 파일을
 * <head>에서 동기 로드한다 — 첫 페인트 전에 저장된 테마를 <html data-theme>
 * 로 찍어 '번쩍임(FOUC)' 없이 적용된다. 각 페이지 CSS 는
 * :root[data-theme="dark"|"light"] 변수 블록으로 이 속성을 존중한다.
 *
 * 규칙: 저장값 없음 = 기기 설정 따름(자동) · 버튼 클릭 = 반대 모드로 전환
 * 하고 localStorage 에 기억 (다음 방문에도 유지).
 */
(function () {
  "use strict";
  var KEY = "wt_theme";
  var root = document.documentElement;
  var mq = window.matchMedia("(prefers-color-scheme: dark)");
  var META = { light: "#fafafa", dark: "#09090b" };

  function saved() {
    try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; }
  }

  function effectiveDark() {
    var t = root.dataset.theme;
    if (t === "dark") return true;
    if (t === "light") return false;
    return mq.matches;
  }

  function syncUi() {
    var dark = effectiveDark();
    var btn = document.getElementById("themeToggle");
    if (btn) {
      // 아이콘 = 지금 모드의 표식 (달=다크, 해=라이트) — 누르면 반대로
      btn.textContent = dark ? "🌙" : "☀️";
      btn.setAttribute("aria-pressed", dark ? "true" : "false");
      btn.title = dark ? "라이트 모드로 전환" : "다크 모드로 전환";
    }
    // 모바일 주소창 색도 함께 맞춘다 (수동 선택 시 media 조건을 걷어냄)
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      var m = metas[i];
      if (root.dataset.theme) {
        if (!m.dataset.origMedia) m.dataset.origMedia = m.getAttribute("media") || "-";
        m.removeAttribute("media");
        m.setAttribute("content", META[root.dataset.theme]);
      } else if (m.dataset.origMedia) {
        if (m.dataset.origMedia !== "-") m.setAttribute("media", m.dataset.origMedia);
        m.setAttribute("content", m.dataset.origMedia.indexOf("dark") >= 0 ? META.dark : META.light);
      }
    }
  }

  function apply(theme, persist) {
    if (theme === "dark" || theme === "light") root.dataset.theme = theme;
    else delete root.dataset.theme;
    if (persist) {
      try {
        if (theme) localStorage.setItem(KEY, theme);
        else localStorage.removeItem(KEY);
      } catch (e) { /* 사생활 모드 등 — 이번 방문만 적용 */ }
    }
    syncUi();
    // 차트(lightweight-charts)처럼 JS 로 색을 칠하는 곳이 다시 그리게 알림
    document.dispatchEvent(new CustomEvent("wt-themechange"));
  }

  // 1) 첫 페인트 전: 저장된 선택을 즉시 적용 (없으면 자동 = 아무것도 안 찍음)
  var initial = saved();
  if (initial === "dark" || initial === "light") root.dataset.theme = initial;

  // 2) DOM 준비 후: 버튼 연결 + 아이콘 동기화
  function ready() {
    var btn = document.getElementById("themeToggle");
    if (btn) {
      btn.addEventListener("click", function () {
        apply(effectiveDark() ? "light" : "dark", true);
      });
    }
    syncUi();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ready);
  } else {
    ready();
  }

  // 자동 모드일 때 기기 설정이 바뀌면 아이콘·차트도 따라간다
  function onSystemChange() {
    if (!root.dataset.theme) {
      syncUi();
      document.dispatchEvent(new CustomEvent("wt-themechange"));
    }
  }
  if (mq.addEventListener) mq.addEventListener("change", onSystemChange);
  else if (mq.addListener) mq.addListener(onSystemChange);
})();
