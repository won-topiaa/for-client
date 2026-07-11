/* 이평선 레이더 프런트엔드 (lightweight-charts v5) */
(function () {
  "use strict";

  const MA_COLORS = ["#f59e0b", "#a78bfa", "#34d399", "#f472b6", "#22d3ee"];
  const TF_LABEL = { day: "일봉", week: "주봉", month: "월봉" };
  // 이벤트 종류별 마커 색 (이평선 색과 무관하게 사건의 성격을 표시)
  const EVENT_COLORS = { support: "#22c55e", resistance: "#f97316", break: "#9ca3af" };

  // 서버/업스트림에서 온 문자열을 innerHTML 에 넣기 전 이스케이프
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  const el = {
    search: document.getElementById("searchInput"),
    suggest: document.getElementById("suggest"),
    analyze: document.getElementById("analyzeBtn"),
    status: document.getElementById("status"),
    result: document.getElementById("result"),
    tabs: document.getElementById("tabs"),
    recoCards: document.getElementById("recoCards"),
    chart: document.getElementById("chart"),
    statsBody: document.getElementById("statsBody"),
    windowNote: document.getElementById("windowNote"),
    markerToggle: document.getElementById("markerToggle"),
    banner: document.getElementById("sampleBanner"),
    yearsDay: document.getElementById("yearsDay"),
    yearsWeek: document.getElementById("yearsWeek"),
    yearsMonth: document.getElementById("yearsMonth"),
  };

  let selected = null;        // {symbol, name}
  let analysis = null;        // /api/analyze 응답
  let currentTf = "day";
  let focusPeriod = null;     // 카드 클릭으로 한 이평선만 보기 (null = 전체)
  let chart = null;
  let candleSeries = null;
  let maSeriesList = [];
  let markersApi = null;

  fetch("/api/health")
    .then((r) => r.json())
    .then((h) => {
      if (h.provider === "sample") el.banner.style.display = "block";
    })
    .catch(() => {});

  /* ---------- 종목 검색 ---------- */
  let searchTimer = null;
  let suggestItems = [];
  let activeIdx = -1;
  let searchSeq = 0; // 응답 역전(느린 이전 응답이 최신 결과를 덮는 것) 방지

  el.search.addEventListener("input", () => {
    selected = null;
    el.analyze.disabled = true;
    clearTimeout(searchTimer);
    const q = el.search.value.trim();
    if (!q) { searchSeq++; hideSuggest(); return; }
    searchTimer = setTimeout(() => doSearch(q), 200);
  });

  el.search.addEventListener("keydown", (e) => {
    if (el.suggest.style.display !== "block") return;
    if (e.key === "ArrowDown") { e.preventDefault(); moveActive(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveActive(-1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIdx >= 0 && suggestItems[activeIdx]) pick(suggestItems[activeIdx]);
      else if (suggestItems.length === 1) pick(suggestItems[0]);
    } else if (e.key === "Escape") hideSuggest();
  });

  document.addEventListener("click", (e) => {
    if (!el.suggest.contains(e.target) && e.target !== el.search) hideSuggest();
  });

  function moveActive(delta) {
    const nodes = el.suggest.children;
    if (!nodes.length) return;
    activeIdx = (activeIdx + delta + nodes.length) % nodes.length;
    Array.from(nodes).forEach((n, i) => n.classList.toggle("active", i === activeIdx));
  }

  async function doSearch(q) {
    const seq = ++searchSeq;
    let items = [];
    try {
      const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const body = await r.json();
      items = body.results || [];
    } catch (err) {
      items = [];
    }
    // 더 최신 요청이 시작됐거나 입력이 바뀌었으면 이 응답은 폐기
    if (seq !== searchSeq || el.search.value.trim() !== q) return;
    suggestItems = items;
    renderSuggest();
  }

  function renderSuggest() {
    el.suggest.innerHTML = "";
    activeIdx = -1;
    if (!suggestItems.length) { hideSuggest(); return; }
    suggestItems.forEach((item) => {
      const div = document.createElement("div");
      const name = document.createElement("span");
      name.textContent = item.name;
      const code = document.createElement("span");
      code.className = "code";
      code.textContent = item.symbol + (item.market ? " · " + item.market : "");
      div.appendChild(name);
      div.appendChild(code);
      div.addEventListener("click", () => pick(item));
      el.suggest.appendChild(div);
    });
    el.suggest.style.display = "block";
  }

  function hideSuggest() { el.suggest.style.display = "none"; }

  function pick(item) {
    selected = item;
    el.search.value = `${item.name} (${item.symbol})`;
    el.analyze.disabled = false;
    hideSuggest();
  }

  /* ---------- 분석 ---------- */
  el.analyze.addEventListener("click", runAnalysis);
  let analyzeSeq = 0; // 늦게 도착한 이전 분석 응답이 최신 결과를 덮지 않도록

  async function runAnalysis() {
    if (!selected) return;
    const seq = ++analyzeSeq;
    el.analyze.disabled = true;
    el.result.style.display = "none";
    el.status.innerHTML = '<span class="spinner"></span>일봉·주봉·월봉 백테스트 중…';
    const params = new URLSearchParams({ symbol: selected.symbol });
    const yd = parseFloat(el.yearsDay.value); if (!isNaN(yd)) params.set("years_day", yd);
    const yw = parseFloat(el.yearsWeek.value); if (!isNaN(yw)) params.set("years_week", yw);
    const ym = parseFloat(el.yearsMonth.value); if (!isNaN(ym)) params.set("years_month", ym);
    try {
      const r = await fetch(`/api/analyze?${params}`);
      if (seq !== analyzeSeq) return; // 더 최신 분석이 시작됨 -> 이 응답 폐기
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${r.status}`);
      }
      const body = await r.json();
      if (seq !== analyzeSeq) return;
      analysis = body;
      focusPeriod = null; // 새 분석 -> 전체 보기로 초기화
      el.status.textContent = "";
      el.result.style.display = "block";
      renderTimeframe(currentTf);
    } catch (err) {
      if (seq === analyzeSeq) el.status.textContent = "분석 실패: " + err.message;
    } finally {
      if (seq === analyzeSeq) el.analyze.disabled = false;
    }
  }

  /* ---------- 탭 ---------- */
  el.tabs.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tf]");
    if (!btn) return;
    currentTf = btn.dataset.tf;
    focusPeriod = null; // 탭 전환 -> 전체 보기로 초기화
    Array.from(el.tabs.children).forEach((b) =>
      b.classList.toggle("active", b === btn)
    );
    renderTimeframe(currentTf);
  });

  el.markerToggle.addEventListener("change", () => renderTimeframe(currentTf));

  /* ---------- 렌더링 ---------- */
  function renderTimeframe(tf) {
    if (!analysis) return;
    const data = analysis.timeframes[tf];
    el.recoCards.innerHTML = "";
    el.statsBody.innerHTML = "";
    destroyChart();

    if (!data || data.error) {
      el.windowNote.textContent = "";
      el.recoCards.innerHTML =
        `<div class="reco-card"><div class="warn">${TF_LABEL[tf]} 분석 실패: ${
          esc(data ? data.error : "데이터 없음")}</div></div>`;
      return;
    }

    // "동시 보기" 카드 — 클릭하면 추천 이평선 전체를 한 번에 표시
    if (data.recommended.length > 1) {
      const allCard = document.createElement("div");
      allCard.className = "reco-card all-card";
      if (focusPeriod === null) allCard.classList.add("focused");
      const dots = data.recommended.map((_, i) =>
        `<span class="dot" style="background:${MA_COLORS[i % MA_COLORS.length]}"></span>`
      ).join("");
      const n = data.recommended.length;
      allCard.innerHTML =
        `<div class="period">${dots}${n === 3 ? "세 개" : n + "개"} 동시</div>` +
        `<div class="meta">추천 이평선 전체 보기</div>` +
        `<div class="card-hint">${focusPeriod === null ? "지금 보는 중" : "클릭하면 전체 표시"}</div>`;
      allCard.addEventListener("click", () => {
        focusPeriod = null;
        renderTimeframe(currentTf);
      });
      el.recoCards.appendChild(allCard);
    }

    // 추천 카드 (클릭 = 해당 이평선만 보기, 다시 클릭 = 전체)
    data.recommended.forEach((rec, i) => {
      const color = MA_COLORS[i % MA_COLORS.length];
      const card = document.createElement("div");
      card.className = "reco-card";
      if (focusPeriod !== null) {
        card.classList.add(focusPeriod === rec.period ? "focused" : "dimmed");
      }
      const rate = (rec.successRate * 100).toFixed(0);
      card.innerHTML =
        `<div class="period"><span class="dot" style="background:${color}"></span>MA ${rec.period}</div>` +
        `<div class="meta">터치 ${rec.touches}회 · 성공률 ${rate}%</div>` +
        `<div class="meta">` +
        `<span style="color:${EVENT_COLORS.support}">지지 ${rec.supportBounces}</span> · ` +
        `<span style="color:${EVENT_COLORS.resistance}">저항 ${rec.resistanceBounces}</span> · ` +
        `<span style="color:${EVENT_COLORS.break}">돌파 ${rec.breaks}</span></div>` +
        (rec.qualified ? "" : `<div class="warn">⚠ 표본 부족 — 참고용</div>`) +
        `<div class="card-hint">${focusPeriod === rec.period ? "클릭하면 전체 보기" : "클릭하면 이 선만 보기"}</div>`;
      card.addEventListener("click", () => {
        focusPeriod = focusPeriod === rec.period ? null : rec.period;
        renderTimeframe(currentTf);
      });
      el.recoCards.appendChild(card);
    });
    if (!data.recommended.length) {
      el.recoCards.innerHTML =
        `<div class="reco-card"><div class="warn">추천할 만한 이평선을 찾지 못했습니다 (데이터/터치 부족)</div></div>`;
    }

    el.windowNote.textContent =
      `분석 구간: ${data.windowStart} ~ ${data.windowEnd} (${TF_LABEL[tf]} ${data.bars}개` +
      (data.lookbackYears ? `, 약 ${data.lookbackYears}년` : ", 전체 기간") +
      `) · 최근 가중 반감기 ${data.halfLifeBars}봉`;

    buildChart(data);
    buildTable(data);
  }

  function destroyChart() {
    if (chart) { chart.remove(); chart = null; }
    candleSeries = null;
    maSeriesList = [];
    markersApi = null;
  }

  function buildChart(data) {
    const LWC = window.LightweightCharts;
    chart = LWC.createChart(el.chart, {
      autoSize: true,
      layout: {
        background: { type: "solid", color: "transparent" },
        textColor: "#8b93a7",
      },
      grid: {
        vertLines: { color: "rgba(42,47,64,.5)" },
        horzLines: { color: "rgba(42,47,64,.5)" },
      },
      crosshair: { mode: LWC.CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#2a2f40" },
      timeScale: { borderColor: "#2a2f40" },
    });
    candleSeries = chart.addSeries(LWC.CandlestickSeries, {
      upColor: "#ef4444", downColor: "#3b82f6",
      wickUpColor: "#ef4444", wickDownColor: "#3b82f6",
      borderVisible: false,
    });
    candleSeries.setData(data.candles);

    // 카드에서 이평선 하나를 선택했으면 그것만, 아니면 전체 표시
    const visible = focusPeriod === null
      ? data.recommended
      : data.recommended.filter((r) => r.period === focusPeriod);

    data.recommended.forEach((rec, i) => {
      if (focusPeriod !== null && rec.period !== focusPeriod) return;
      const color = MA_COLORS[i % MA_COLORS.length];
      const line = chart.addSeries(LWC.LineSeries, {
        color, lineWidth: focusPeriod === null ? 2 : 3,
        priceLineVisible: false,
        lastValueVisible: false, crosshairMarkerVisible: false,
        title: `MA${rec.period}`,
      });
      line.setData(rec.ma);
      maSeriesList.push(line);
    });

    if (el.markerToggle.checked) {
      const markers = collectMarkers(visible);
      if (markers.length) {
        markersApi = LWC.createSeriesMarkers(candleSeries, markers);
      }
    }
    chart.timeScale().fitContent();
  }

  function collectMarkers(recList) {
    const markers = [];
    recList.forEach((rec) => {
      rec.events.forEach((ev) => {
        if (ev.outcome === "undecided") return;
        const isSupport = ev.side === "support";
        const failed = ev.outcome === "break";
        // 색 = 사건 종류: 지지 성공(초록▲) / 저항 성공(주황▼) / 돌파 실패(회색●)
        markers.push({
          time: ev.time,
          position: isSupport ? "belowBar" : "aboveBar",
          shape: failed ? "circle" : (isSupport ? "arrowUp" : "arrowDown"),
          color: failed
            ? EVENT_COLORS.break
            : (isSupport ? EVENT_COLORS.support : EVENT_COLORS.resistance),
          size: 1,
        });
      });
    });
    markers.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    // 마커가 너무 많으면 차트가 지저분해지므로 최근 120개만
    return markers.slice(-120);
  }

  function buildTable(data) {
    const recoSet = new Set(data.recommended.map((r) => r.period));
    const rows = [...data.stats].sort((a, b) => b.score - a.score);
    rows.forEach((s) => {
      const tr = document.createElement("tr");
      if (recoSet.has(s.period)) tr.className = "reco";
      else if (s.insufficientData || !s.touches) tr.className = "dim";
      const rate = s.insufficientData ? "—" : (s.successRate * 100).toFixed(0) + "%";
      tr.innerHTML =
        `<td>MA ${s.period}${recoSet.has(s.period) ? " ★" : ""}</td>` +
        `<td>${s.insufficientData ? "데이터 부족" : s.touches}</td>` +
        `<td>${s.supportBounces}</td><td>${s.resistanceBounces}</td>` +
        `<td>${s.breaks}</td><td>${s.undecided}</td>` +
        `<td>${rate}</td><td>${s.score.toFixed(3)}</td>` +
        `<td>${esc(s.lastTouch || "—")}</td>`;
      el.statsBody.appendChild(tr);
    });
  }
})();
