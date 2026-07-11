/* 차트 패턴 스크리너 프런트엔드 */
(function () {
  "use strict";

  const OVERLAY_COLORS = ["#f59e0b", "#a78bfa", "#22d3ee"];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  const el = {
    cards: document.getElementById("patternCards"),
    chips: document.getElementById("stageChips"),
    status: document.getElementById("status"),
    matches: document.getElementById("matches"),
  };

  let pattern = "stage";
  let stage = 2;
  let pollTimer = null;
  let reqSeq = 0;
  const charts = [];

  el.cards.addEventListener("click", (e) => {
    const card = e.target.closest(".p-card");
    if (!card) return;
    pattern = card.dataset.pattern;
    Array.from(el.cards.children).forEach((c) =>
      c.classList.toggle("active", c === card));
    el.chips.style.display = pattern === "stage" ? "flex" : "none";
    load();
  });

  el.chips.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-stage]");
    if (!btn) return;
    stage = parseInt(btn.dataset.stage, 10);
    Array.from(el.chips.children).forEach((b) =>
      b.classList.toggle("active", b === btn));
    load();
  });

  function destroyCharts() {
    charts.forEach((c) => c.remove());
    charts.length = 0;
  }

  async function load() {
    const seq = ++reqSeq;
    clearTimeout(pollTimer);
    destroyCharts();
    el.matches.innerHTML = "";
    el.status.innerHTML = '<span class="spinner"></span>패턴 스캔 중…';
    try {
      const r = await fetch(`/api/patterns?pattern=${pattern}&stage=${stage}`);
      if (seq !== reqSeq) return;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      if (seq !== reqSeq) return;
      if (body.status === "running") {
        const pct = body.total ? Math.round((body.done / body.total) * 100) : 0;
        el.status.innerHTML =
          `<span class="spinner"></span>전 종목 스캔 중… ${body.done}/${body.total} 종목` +
          `<div class="bar"><div style="width:${pct}%"></div></div>`;
        pollTimer = setTimeout(load, 2000);
        return;
      }
      render(body);
    } catch (err) {
      if (seq === reqSeq) el.status.textContent = "스캔 실패: " + err.message;
    }
  }

  function render(body) {
    el.status.textContent =
      `${body.scanned}개 종목 스캔 완료 · 매칭 ${body.totalMatches}개` +
      (body.totalMatches > body.matches.length
        ? ` (상위 ${body.matches.length}개 표시)` : "");
    if (!body.matches.length) {
      el.matches.innerHTML =
        `<div class="empty">지금 이 패턴에 해당하는 종목이 없습니다.<br>` +
        `<span style="font-size:12px">패턴은 시장 상황에 따라 나타났다 사라집니다 — 다른 패턴을 보거나 나중에 다시 확인해 보세요.</span></div>`;
      return;
    }
    body.matches.forEach((m) => {
      const card = document.createElement("div");
      card.className = "m-card";
      card.innerHTML =
        `<div class="m-head">` +
        `<span><span class="m-name">${esc(m.name)}</span> ` +
        `<span class="m-code">${esc(m.symbol)}${m.market ? " · " + esc(m.market) : ""}</span></span>` +
        `<span><span class="m-score">매칭점수 ${Number(m.score).toFixed(2)}</span> ` +
        `<a class="m-link" href="/?symbol=${encodeURIComponent(m.symbol)}">이평선 분석 →</a></span>` +
        `</div>` +
        `<div class="m-summary">${esc(m.summary)}</div>` +
        `<div class="m-chart"></div>`;
      el.matches.appendChild(card);
      drawChart(card.querySelector(".m-chart"), m);
    });
  }

  function drawChart(container, m) {
    const LWC = window.LightweightCharts;
    const chart = LWC.createChart(container, {
      autoSize: true,
      layout: { background: { type: "solid", color: "transparent" }, textColor: "#8b93a7", fontSize: 11 },
      grid: { vertLines: { color: "rgba(42,47,64,.4)" }, horzLines: { color: "rgba(42,47,64,.4)" } },
      rightPriceScale: { borderColor: "#2a2f40" },
      timeScale: { borderColor: "#2a2f40" },
      handleScroll: false, handleScale: false,
    });
    const candles = chart.addSeries(LWC.CandlestickSeries, {
      upColor: "#ef4444", downColor: "#3b82f6",
      wickUpColor: "#ef4444", wickDownColor: "#3b82f6",
      borderVisible: false, priceLineVisible: false, lastValueVisible: false,
    });
    candles.setData(m.candles);
    (m.overlays || []).forEach((ov, i) => {
      const line = chart.addSeries(LWC.LineSeries, {
        color: OVERLAY_COLORS[i % OVERLAY_COLORS.length],
        lineWidth: 2, lineStyle: ov.name && ov.name.includes("넥") ? 1 : 0,
        priceLineVisible: false, lastValueVisible: false,
        crosshairMarkerVisible: false, title: ov.name || "",
      });
      line.setData(ov.points);
    });
    chart.timeScale().fitContent();
    charts.push(chart);
  }

  load();
})();
