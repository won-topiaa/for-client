/* 헤더 지수 티커 — 주요 지수 스냅샷을 5분 주기로 갱신 */
(function () {
  "use strict";

  const wrap = document.getElementById("tickerWrap");
  const bar = document.getElementById("tickerBar");
  if (!wrap || !bar) return;

  // EN 모드: 지수 이름만 영문 표기 (서버 응답은 그대로 — 표시만 바꾼다)
  const NAME_EN = { "코스피": "KOSPI", "코스닥": "KOSDAQ", "나스닥": "NASDAQ" };
  const dispName = (n) =>
    (window.WT_LANG === "en" && NAME_EN[n]) ? NAME_EN[n] : n;

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
  let inFlight = false;

  async function refresh() {
    if (inFlight) return;  // 이전 요청이 60초 넘게 걸려도 겹쳐 쏘지 않는다
    inFlight = true;
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
          `<span class="tk"><span class="tk-name">${esc(dispName(it.name))}</span>` +
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
    } finally {
      inFlight = false;
    }
  }

  refresh();
  // 1분마다 갱신 — 서버가 2분 캐시로 신선한 지수를 내주므로 장중 움직임이 보인다
  setInterval(refresh, 60 * 1000);
})();
