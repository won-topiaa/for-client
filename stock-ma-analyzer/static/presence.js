/* 동시 접속자 배지 — 주기적 하트비트로 '지금 접속 중' 인원을 보여준다.
   저장하는 건 임의의 클라이언트 ID 하나뿐(개인정보 아님). */
(function () {
  "use strict";

  var badge = document.getElementById("presenceBadge");
  var out = document.getElementById("presenceCount");
  if (!badge || !out) return;

  // 브라우저별 임의 ID (중복 카운트 방지). localStorage 를 못 쓰면 세션 한정 ID.
  var KEY = "wontopia_cid";
  var cid = "";
  try {
    cid = localStorage.getItem(KEY) || "";
    if (!cid) {
      cid = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(KEY, cid);
    }
  } catch (e) {
    cid = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  var inFlight = false;

  function ping() {
    if (inFlight) return;
    inFlight = true;
    fetch("/api/presence?cid=" + encodeURIComponent(cid), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && typeof d.active === "number" && d.active > 0) {
          out.textContent = d.active.toLocaleString("ko-KR");
          badge.style.display = "inline-flex";
          var TR = window.WT_T || function (ko) { return ko; };
          badge.setAttribute("aria-label",
            TR("지금 " + d.active + "명 접속 중", d.active + " visitors online now"));
        }
      })
      .catch(function () { /* 실패해도 조용히 — 다음 주기에 재시도 */ })
      .then(function () { inFlight = false; });
  }

  ping();
  setInterval(ping, 45 * 1000);
  // 탭이 다시 보이면 즉시 갱신 (오래 방치 후 복귀 시 최신 수치)
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) ping();
  });
})();
