/* 헤더 지수 티커 — 주요 지수 스냅샷을 5분 주기로 갱신 */
(function () {
  "use strict";

  const wrap = document.getElementById("tickerWrap");
  const bar = document.getElementById("tickerBar");
  if (!wrap || !bar) return;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  function fmt(n) {
    return Number(n).toLocaleString("ko-KR", {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }

  let hasData = false;

  async function refresh() {
    try {
      const r = await fetch("/api/indices");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      const items = body.indices || [];
      if (!items.length) { wrap.style.display = "none"; return; }
      bar.innerHTML = items.map((it) => {
        const flat = Math.abs(it.changePct) < 0.005;
        const up = it.changePct > 0;
        const cls = flat ? "flat" : up ? "up" : "down";
        const arrow = flat ? "" : up ? "▲" : "▼";
        return (
          `<span class="tk"><span class="tk-name">${esc(it.name)}</span>` +
          `<span class="tk-val">${esc(fmt(it.value))}</span>` +
          `<span class="tk-chg ${cls}">${arrow}${Math.abs(it.changePct).toFixed(2)}%</span></span>`
        );
      }).join("");
      wrap.style.display = "";
      hasData = true;
    } catch (err) {
      // 처음부터 못 가져온 경우만 숨긴다 — 일시 오류에는 마지막 정상
      // 시세를 유지하는 편이 5분간 빈 줄보다 낫다 (티커는 장식)
      if (!hasData) wrap.style.display = "none";
    }
  }

  refresh();
  setInterval(refresh, 5 * 60 * 1000);
})();
