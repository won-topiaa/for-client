/* 오늘의 지지선 터치 프런트엔드 */
(function () {
  "use strict";

  // 라이트/다크 자동 대응 차트 테마 (사이트 공통 규약)
  const darkMq = window.matchMedia("(prefers-color-scheme: dark)");
  function chartTheme() {
    const dark = darkMq.matches;
    return {
      text: dark ? "#a1a1aa" : "#71717a",
      grid: dark ? "rgba(39,39,42,.6)" : "rgba(228,228,231,.8)",
      border: dark ? "#27272a" : "#e4e4e7",
      up: dark ? "#34d399" : "#059669",
      down: dark ? "#f87171" : "#dc2626",
      maLine: dark ? "#fbbf24" : "#d97706",   // 터치한 이평선 (앰버)
      marker: dark ? "#818cf8" : "#4f46e5",   // 오늘 터치 표시 (인디고)
    };
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  const el = {
    marketToggle: document.getElementById("marketToggle"),
    status: document.getElementById("scanStatus"),
    matches: document.getElementById("matches"),
    party: document.getElementById("scanParty"),
    partyCaption: document.getElementById("partyCaption"),
  };

  const CAPTIONS = [
    "양봉이와 음봉이가 지지선을 짚어보는 중…",
    "3년치 반등 기록을 뒤지는 중…",
    "오늘 저가가 선에 닿았는지 자로 재보는 중…",
    "성공률 낮은 선은 걸러내는 중…",
    "허용 밴드(0.5×ATR)를 계산하는 중…",
  ];
  let captionIdx = 0;
  let captionTimer = null;

  function showParty(on) {
    el.party.style.display = on ? "flex" : "none";
    el.partyCaption.style.display = on ? "block" : "none";
    if (on) {
      if (!captionTimer) {
        captionTimer = setInterval(() => {
          captionIdx = (captionIdx + 1) % CAPTIONS.length;
          el.partyCaption.textContent = CAPTIONS[captionIdx];
        }, 3500);
      }
    } else if (captionTimer) {
      clearInterval(captionTimer);
      captionTimer = null;
    }
  }

  let market = "kr";
  let pollTimer = null;
  let reqSeq = 0;
  let renderedWhileRefreshing = false;
  let pollFails = 0;
  const charts = [];

  el.marketToggle.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-market]");
    if (!btn) return;
    market = btn.dataset.market;
    Array.from(el.marketToggle.children).forEach((b) => {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-pressed", b === btn ? "true" : "false");
    });
    load();
  });

  function destroyCharts() {
    charts.forEach((c) => c.remove());
    charts.length = 0;
  }

  function updateProgress(body) {
    const label =
      `${market === "kr" ? "국내" : "미국"} 종목 백테스트 중… ` +
      (body.total ? `${body.done}/${body.total} 종목` : "대상 선정 중");
    const pct = body.total ? Math.round((body.done / body.total) * 100) : 0;
    let bar = el.status.querySelector(".bar > div");
    if (!bar) {
      el.status.innerHTML =
        `<span class="scan-label"></span><div class="bar"><div style="width:0%"></div></div>`;
      bar = el.status.querySelector(".bar > div");
    }
    el.status.querySelector(".scan-label").textContent = label;
    bar.style.width = pct + "%";
  }

  async function load(isPoll) {
    const seq = ++reqSeq;
    clearTimeout(pollTimer);
    if (!isPoll) {
      destroyCharts();
      el.matches.innerHTML = "";
      renderedWhileRefreshing = false;
      lastBody = null;
      el.status.innerHTML = '<span class="spinner"></span>지지선 터치 스캔 중…';
    }
    try {
      const r = await fetch(`/api/touches?market=${market}`);
      if (seq !== reqSeq) return;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      if (seq !== reqSeq) return;
      pollFails = 0;
      if (body.status === "running") {
        showParty(true);
        updateProgress(body);
        pollTimer = setTimeout(() => load(true), 2000);
        return;
      }
      if (body.status === "error") {
        showParty(false);
        destroyCharts();
        el.matches.innerHTML = "";
        lastBody = null;
        el.status.textContent = body.detail || "스캔 실패 — 잠시 후 다시 시도해 주세요.";
        pollTimer = setTimeout(() => load(true), 15000);
        return;
      }
      showParty(false);
      if (isPoll && renderedWhileRefreshing && body.refreshing) {
        pollTimer = setTimeout(() => load(true), 5000);
        return;
      }
      render(body);
      renderedWhileRefreshing = !!body.refreshing;
      if (body.refreshing) pollTimer = setTimeout(() => load(true), 5000);
    } catch (err) {
      if (seq !== reqSeq) return;
      if (isPoll && pollFails < 3) {
        pollFails += 1;
        pollTimer = setTimeout(() => load(true), 4000);
        return;
      }
      showParty(false);
      el.status.textContent = "스캔 실패: " + err.message;
    }
  }

  // OS 테마가 바뀌면 마지막 결과를 새 팔레트로 다시 그린다
  let lastBody = null;
  function onThemeChange() { if (lastBody) render(lastBody); }
  if (darkMq.addEventListener) darkMq.addEventListener("change", onThemeChange);
  else if (darkMq.addListener) darkMq.addListener(onThemeChange);

  function render(body) {
    lastBody = body;
    destroyCharts();
    el.matches.innerHTML = "";
    el.status.textContent =
      `${body.scanned}개 종목 백테스트 완료 · 오늘 지지선 터치 ${body.totalMatches}개` +
      (body.totalMatches > body.matches.length
        ? ` (상위 ${body.matches.length}개 표시)` : "") +
      (body.refreshing ? " · 백그라운드에서 새 스캔 진행 중" : "");
    if (!body.matches.length) {
      el.matches.innerHTML =
        `<div class="empty">오늘 검증된 지지선에 닿아 있는 종목이 없습니다.<br>` +
        `<span style="font-size:12px">터치는 매일 달라집니다 — 내일 다시 확인하거나 다른 시장을 살펴보세요.</span></div>`;
      return;
    }
    body.matches.forEach((m) => {
      const card = document.createElement("div");
      card.className = "m-card";
      const rate = (m.successRate * 100).toFixed(0);
      const dist = m.distPct > 0 ? `+${m.distPct}%` : `${m.distPct}%`;
      card.innerHTML =
        `<div class="m-head">` +
        `<span><span class="m-name">${esc(m.name)}</span> ` +
        `<span class="m-code">${esc(m.symbol)}${m.market ? " · " + esc(m.market) : ""}</span></span>` +
        `<span><span class="ma-chip">MA ${esc(m.period)}</span> ` +
        `<a class="m-link" href="/ma?symbol=${encodeURIComponent(m.symbol)}">이평선 분석 →</a></span>` +
        `</div>` +
        `<div class="m-summary">3년 가중 성공률 <b>${esc(rate)}%</b> · 지지 성공 ${esc(m.supportBounces)}회 (터치 ${esc(m.touches)}회) · ` +
        `오늘 종가는 선 대비 <b>${esc(dist)}</b> (선 ${esc(m.maValue)})</div>` +
        `<div class="m-chart"></div>`;
      el.matches.appendChild(card);
      drawChart(card.querySelector(".m-chart"), m);
    });
  }

  function drawChart(container, m) {
    const LWC = window.LightweightCharts;
    const T = chartTheme();
    const chart = LWC.createChart(container, {
      autoSize: true,
      layout: { background: { type: "solid", color: "transparent" }, textColor: T.text, fontSize: 11 },
      grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
      rightPriceScale: { borderColor: T.border },
      timeScale: { borderColor: T.border },
      handleScroll: false, handleScale: false,
    });
    const candles = chart.addSeries(LWC.CandlestickSeries, {
      upColor: T.up, downColor: T.down,
      wickUpColor: T.up, wickDownColor: T.down,
      borderVisible: false, priceLineVisible: false, lastValueVisible: false,
    });
    candles.setData(m.candles);
    const line = chart.addSeries(LWC.LineSeries, {
      color: T.maLine, lineWidth: 2,
      priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, title: `MA${m.period}`,
    });
    line.setData(m.maLine);
    // 오늘(마지막 봉)의 터치 지점 표시
    if (m.candles.length) {
      LWC.createSeriesMarkers(candles, [{
        time: m.candles[m.candles.length - 1].time,
        position: "belowBar", shape: "arrowUp", color: T.marker, size: 1,
        text: "터치",
      }]);
    }
    chart.timeScale().fitContent();
    charts.push(chart);
  }

  load();
})();
