/* 이평선 레이더 프런트엔드 (lightweight-charts v5) */
(function () {
  "use strict";

  // 한/영 분기 — i18n.js 가 head 에서 window.WT_T 를 정의한다 (없으면 한국어)
  const TR = window.WT_T || function (ko) { return ko; };
  const TF_LABEL = window.WT_LANG === "en"
    ? { day: "Daily", week: "Weekly", month: "Monthly" }
    : { day: "일봉", week: "주봉", month: "월봉" };

  // 라이트/다크 자동 대응 차트 테마 (에메랄드=상승 · 빨강=하락, 사이트 공통 규약)
  // 마커 색 = 사건 후 방향: 상승성(지지 성공·저항 돌파)=에메랄드, 하락성(저항 성공·지지 이탈)=빨강.
  // 모양이 종류를 구분: 화살표=이평선이 버팀, 원=뚫림.
  const darkMq = window.matchMedia("(prefers-color-scheme: dark)");
  function chartTheme() {
    // 수동 전환(data-theme)이 있으면 그걸, 없으면 기기 설정을 따른다
    const forced = document.documentElement.dataset.theme;
    const dark = forced === "dark" || (forced !== "light" && darkMq.matches);
    return {
      text: dark ? "#a1a1aa" : "#71717a",
      grid: dark ? "rgba(39,39,42,.6)" : "rgba(228,228,231,.8)",
      border: dark ? "#27272a" : "#e4e4e7",
      up: dark ? "#34d399" : "#059669",
      down: dark ? "#f87171" : "#dc2626",
      // 이평선: 캔들(에메랄드/빨강)과 겹치지 않는 인디고·앰버·시안 계열
      ma: dark ? ["#818cf8", "#fbbf24", "#22d3ee", "#f472b6", "#a3e635"]
               : ["#4f46e5", "#d97706", "#0891b2", "#db2777", "#65a30d"],
      events: dark
        ? { support: "#34d399", resistance: "#f87171", breakDown: "#f87171", breakUp: "#34d399" }
        : { support: "#059669", resistance: "#dc2626", breakDown: "#dc2626", breakUp: "#059669" },
    };
  }
  // 테마가 바뀌면 차트를 새 팔레트로 다시 그린다. 신호는 theme.js 의
  // wt-themechange 하나로 통일 — 자동 모드의 OS 변경도 theme.js 가 이 이벤트로
  // 중계하므로, 여기서 OS(matchMedia)를 또 들으면 이중 재렌더(줌 리셋 2번)가 된다.
  function onThemeChange() { if (analysis) renderTimeframe(currentTf); }
  document.addEventListener("wt-themechange", onThemeChange);

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

  // 심볼로 종목을 찾아 선택·분석. keepUserInput 이면 응답을 기다리는 사이
  // 사용자가 이미 검색/선택을 시작했을 때 그 입력을 덮어쓰지 않는다.
  function lookupAndAnalyze(sym, keepUserInput) {
    if (!sym || !/^[A-Za-z0-9.\-]{1,20}$/.test(sym)) return;
    fetch(`/api/search?q=${encodeURIComponent(sym)}`)
      .then((r) => r.json())
      .then((body) => {
        if (keepUserInput && (selected !== null || el.search.value.trim() !== "")) return;
        const hit = (body.results || []).find((x) => x.symbol === sym)
          || (body.results || [])[0];
        if (hit) {
          pick(hit);
          runAnalysis();
        }
      })
      .catch(() => {});
  }

  // 패턴 스크리너 등에서 /ma?symbol=005930 으로 진입하면 자동으로 선택·분석
  lookupAndAnalyze(new URLSearchParams(location.search).get("symbol"), true);

  /* ---------- 대표 종목 바로 분석 ---------- */
  const quickPicks = document.getElementById("quickPicks");
  if (quickPicks) {
    quickPicks.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-symbol]");
      if (!btn) return;
      pick({
        symbol: btn.dataset.symbol,
        name: btn.dataset.name,
        market: btn.dataset.market,
      });
      runAnalysis();
    });
  }

  /* ---------- 종목 검색 ---------- */
  let searchTimer = null;
  let suggestItems = [];
  let activeIdx = -1;
  let searchSeq = 0; // 응답 역전(느린 이전 응답이 최신 결과를 덮는 것) 방지

  el.search.addEventListener("input", () => {
    selected = null;
    syncQuickPicks();
    el.analyze.disabled = true;
    clearTimeout(searchTimer);
    const q = el.search.value.trim();
    if (!q) { searchSeq++; hideSuggest(); return; }
    searchTimer = setTimeout(() => doSearch(q), 200);
  });

  el.search.addEventListener("keydown", (e) => {
    // Escape 는 목록이 아직 안 열렸어도(디바운스/요청 대기 중) 취소로 동작해야 한다
    if (e.key === "Escape") { hideSuggest(); return; }
    if (el.suggest.style.display !== "block") return;
    if (e.key === "ArrowDown") { e.preventDefault(); moveActive(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveActive(-1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIdx >= 0 && suggestItems[activeIdx]) pick(suggestItems[activeIdx]);
      else if (suggestItems.length === 1) pick(suggestItems[0]);
    }
  });

  document.addEventListener("click", (e) => {
    if (!el.suggest.contains(e.target) && e.target !== el.search) hideSuggest();
  });

  function moveActive(delta) {
    const nodes = el.suggest.children;
    if (!nodes.length) return;
    // 선택 전(-1) 첫 이동: ↓는 첫 항목, ↑는 마지막 항목 (모듈러만 쓰면
    // 첫 ↑가 끝에서 두 번째에 떨어진다)
    if (activeIdx === -1) {
      activeIdx = delta < 0 ? nodes.length - 1 : 0;
    } else {
      activeIdx = (activeIdx + delta + nodes.length) % nodes.length;
    }
    Array.from(nodes).forEach((n, i) => {
      n.classList.toggle("active", i === activeIdx);
      n.setAttribute("aria-selected", i === activeIdx ? "true" : "false");
    });
    // 목록이 스크롤될 만큼 길면 활성 항목을 시야로
    nodes[activeIdx].scrollIntoView({ block: "nearest" });
    el.search.setAttribute("aria-activedescendant", nodes[activeIdx].id);
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
    // 목록이 새로 그려지면 이전 활성 항목 참조도 무효 — AT 오보 방지
    el.search.removeAttribute("aria-activedescendant");
    if (!suggestItems.length) { hideSuggest(); return; }
    suggestItems.forEach((item, i) => {
      const div = document.createElement("div");
      div.id = "sug-" + i;
      div.setAttribute("role", "option");
      div.setAttribute("aria-selected", "false");
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
    el.search.setAttribute("aria-expanded", "true");
  }

  function hideSuggest() {
    // 닫기는 '취소'다: 대기 중인 디바운스와 진행 중인 응답도 무효화해야
    // 닫힌 직후 뒤늦은 결과가 목록을 다시 열지 않는다
    clearTimeout(searchTimer);
    searchSeq++;
    el.suggest.style.display = "none";
    el.search.setAttribute("aria-expanded", "false");
    el.search.removeAttribute("aria-activedescendant");
  }

  function pick(item) {
    clearTimeout(searchTimer);  // 디바운스 대기 중인 불필요한 검색 취소
    selected = item;
    el.search.value = `${item.name} (${item.symbol})`;
    el.analyze.disabled = false;
    hideSuggest();
    syncQuickPicks();
  }

  // 지금 선택된 종목과 같은 대표 종목 칩을 반전 표시 (참고 사이트의 '빠른 선택' 패턴)
  function syncQuickPicks() {
    if (!quickPicks) return;
    quickPicks.querySelectorAll("button[data-symbol]").forEach((btn) => {
      btn.classList.toggle(
        "active", !!selected && btn.dataset.symbol === selected.symbol);
    });
  }

  /* ---------- 분석 ---------- */
  el.analyze.addEventListener("click", runAnalysis);
  let analyzeSeq = 0; // 늦게 도착한 이전 분석 응답이 최신 결과를 덮지 않도록

  async function runAnalysis() {
    if (!selected) return;
    const seq = ++analyzeSeq;
    el.analyze.disabled = true;
    el.result.style.display = "none";
    el.status.innerHTML = '<span class="spinner"></span>' + TR("일봉·주봉·월봉 백테스트 중…", "Backtesting daily · weekly · monthly bars…");
    const params = new URLSearchParams({ symbol: selected.symbol });
    const yd = parseFloat(el.yearsDay.value); if (!isNaN(yd)) params.set("years_day", yd);
    const yw = parseFloat(el.yearsWeek.value); if (!isNaN(yw)) params.set("years_week", yw);
    const ym = parseFloat(el.yearsMonth.value); if (!isNaN(ym)) params.set("years_month", ym);
    try {
      const r = await fetch(`/api/analyze?${params}`);
      if (seq !== analyzeSeq) return; // 더 최신 분석이 시작됨 -> 이 응답 폐기
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        // FastAPI 검증 오류(422)의 detail 은 객체 배열이라 그대로 쓰면
        // "[object Object]" 로 표시됨 -> 사람이 읽을 문장으로 변환
        const d = err.detail;
        const msg = typeof d === "string" ? d
          : Array.isArray(d) ? d.map((x) => x.msg || String(x)).join(", ")
          : `HTTP ${r.status}`;
        throw new Error(msg);
      }
      const body = await r.json();
      if (seq !== analyzeSeq) return;
      analysis = body;
      focusPeriod = null; // 새 분석 -> 전체 보기로 초기화
      el.status.textContent = "";
      el.result.style.display = "flex";
      renderTimeframe(currentTf);
    } catch (err) {
      if (seq === analyzeSeq) el.status.textContent = TR("분석 실패: ", "Analysis failed: ") + err.message;
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
  // 카드 하나를 클릭/키보드(Enter·Space)로 모두 누를 수 있게 만든다
  function cardButton(card, pressed, onActivate) {
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-pressed", pressed ? "true" : "false");
    card.addEventListener("click", onActivate);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onActivate(); }
    });
  }

  function renderTimeframe(tf, refocusKey) {
    if (!analysis) return;
    const T = chartTheme();
    const data = analysis.timeframes[tf];
    el.recoCards.innerHTML = "";
    el.statsBody.innerHTML = "";
    destroyChart();

    if (!data || data.error) {
      el.windowNote.textContent = "";
      el.recoCards.innerHTML =
        `<div class="reco-card"><div class="warn">${TF_LABEL[tf]} ${TR("분석 실패:", "analysis failed:")} ${
          esc(data ? data.error : TR("데이터 없음", "no data"))}</div></div>`;
      return;
    }
    if (!Array.isArray(data.recommended)) {
      // 방어: 오류도 아닌데 recommended 가 없는 응답이 와도 탭 전환이 깨지지 않게
      el.windowNote.textContent = "";
      el.recoCards.innerHTML =
        `<div class="reco-card"><div class="warn">${TF_LABEL[tf]} ${TR("분석 결과가 비어 있습니다", "analysis returned no result")}</div></div>`;
      return;
    }

    // "동시 보기" 카드 — 클릭하면 추천 이평선 전체를 한 번에 표시
    if (data.recommended.length > 1) {
      const allCard = document.createElement("div");
      allCard.className = "reco-card all-card";
      if (focusPeriod === null) allCard.classList.add("focused");
      const dots = data.recommended.map((_, i) =>
        `<span class="dot" style="background:${T.ma[i % T.ma.length]}"></span>`
      ).join("");
      const n = data.recommended.length;
      allCard.innerHTML =
        `<div class="period">${dots}${TR(`${n === 3 ? "세 개" : n + "개"} 동시`, `all ${n} together`)}</div>` +
        `<div class="meta">${TR("추천 이평선 전체 보기", "Show every recommended MA")}</div>` +
        `<div class="card-hint">${focusPeriod === null ? TR("지금 보는 중", "Now showing") : TR("클릭하면 전체 표시", "Click to show all")}</div>`;
      allCard.dataset.cardKey = "all";
      cardButton(allCard, focusPeriod === null, () => {
        focusPeriod = null;
        renderTimeframe(currentTf, "all");
      });
      el.recoCards.appendChild(allCard);
    }

    // 추천 카드 (클릭 = 해당 이평선만 보기, 다시 클릭 = 전체)
    data.recommended.forEach((rec, i) => {
      const color = T.ma[i % T.ma.length];
      const card = document.createElement("div");
      card.className = "reco-card";
      if (focusPeriod !== null) {
        card.classList.add(focusPeriod === rec.period ? "focused" : "dimmed");
      }
      const rate = (rec.successRate * 100).toFixed(0);
      // 이탈(지지가 아래로 뚫림) / 돌파(저항이 위로 뚫림) 를 나눠서 표시
      const breakDown = rec.events.filter(
        (e) => e.outcome === "break" && e.side === "support").length;
      const breakUp = rec.events.filter(
        (e) => e.outcome === "break" && e.side === "resistance").length;
      card.innerHTML =
        `<div class="period"><span class="dot" style="background:${color}"></span>MA ${rec.period}</div>` +
        `<div class="meta">${TR(`터치 ${rec.touches}회 · 성공률 ${rate}%`, `${rec.touches} touches · ${rate}% success`)}</div>` +
        `<div class="meta">` +
        `<span style="color:${T.events.support}">${TR("지지", "Sup")} ${rec.supportBounces}</span> · ` +
        `<span style="color:${T.events.resistance}">${TR("저항", "Res")} ${rec.resistanceBounces}</span> · ` +
        `<span style="color:${T.events.breakDown}">${TR("이탈", "BrkDn")} ${breakDown}</span> · ` +
        `<span style="color:${T.events.breakUp}">${TR("돌파", "BrkUp")} ${breakUp}</span></div>` +
        (rec.qualified ? "" : `<div class="warn">${TR("⚠ 표본 부족 — 참고용", "⚠ Small sample — indicative only")}</div>`) +
        `<div class="card-hint">${focusPeriod === rec.period ? TR("클릭하면 전체 보기", "Click to show all") : TR("클릭하면 이 선만 보기", "Click to isolate this line")}</div>`;
      card.dataset.cardKey = String(rec.period);
      cardButton(card, focusPeriod === rec.period, () => {
        focusPeriod = focusPeriod === rec.period ? null : rec.period;
        renderTimeframe(currentTf, String(rec.period));
      });
      el.recoCards.appendChild(card);
    });
    if (!data.recommended.length) {
      el.recoCards.innerHTML =
        `<div class="reco-card"><div class="warn">${TR("추천할 만한 이평선을 찾지 못했습니다 (데이터/터치 부족)", "No MA worth recommending (not enough data/touches)")}</div></div>`;
    }

    el.windowNote.textContent = TR(
      `분석 구간: ${data.windowStart} ~ ${data.windowEnd} (${TF_LABEL[tf]} ${data.bars}개` +
        (data.lookbackYears ? `, 약 ${data.lookbackYears}년` : ", 전체 기간") +
        `) · 최근 가중 반감기 ${data.halfLifeBars}봉`,
      `Window: ${data.windowStart} \u2013 ${data.windowEnd} (${data.bars} ${TF_LABEL[tf].toLowerCase()} bars` +
        (data.lookbackYears ? `, ~${data.lookbackYears}y` : ", full history") +
        `) \u00B7 recency half-life ${data.halfLifeBars} bars`);

    buildChart(data);
    buildTable(data);

    // 카드 활성화로 다시 그린 경우, 새로 만든 같은 카드에 포커스를 되돌려
    // 키보드 사용자가 위치를 잃지 않게 한다
    if (refocusKey !== undefined) {
      const target = el.recoCards.querySelector(`[data-card-key="${refocusKey}"]`);
      if (target) target.focus();
    }
  }

  function destroyChart() {
    if (chart) { chart.remove(); chart = null; }
    candleSeries = null;
    maSeriesList = [];
    markersApi = null;
  }

  function buildChart(data) {
    const LWC = window.LightweightCharts;
    const T = chartTheme();
    chart = LWC.createChart(el.chart, {
      autoSize: true,
      layout: {
        background: { type: "solid", color: "transparent" },
        textColor: T.text,
      },
      grid: {
        vertLines: { color: T.grid },
        horzLines: { color: T.grid },
      },
      crosshair: { mode: LWC.CrosshairMode.Normal },
      rightPriceScale: { borderColor: T.border },
      timeScale: { borderColor: T.border },
    });
    candleSeries = chart.addSeries(LWC.CandlestickSeries, {
      upColor: T.up, downColor: T.down,
      wickUpColor: T.up, wickDownColor: T.down,
      borderVisible: false,
    });
    candleSeries.setData(data.candles);

    // 카드에서 이평선 하나를 선택했으면 그것만, 아니면 전체 표시
    const visible = focusPeriod === null
      ? data.recommended
      : data.recommended.filter((r) => r.period === focusPeriod);

    data.recommended.forEach((rec, i) => {
      if (focusPeriod !== null && rec.period !== focusPeriod) return;
      const color = T.ma[i % T.ma.length];
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
    const T = chartTheme();
    recList.forEach((rec) => {
      rec.events.forEach((ev) => {
        if (ev.outcome === "undecided") return;
        const isSupport = ev.side === "support";
        const failed = ev.outcome === "break";
        // 색 = 사건 후 방향(에메랄드=상승성/빨강=하락성), 모양 = 버팀(화살표)/뚫림(원)
        //   지지 성공(에메랄드▲) / 저항 성공(빨강▼)
        //   지지 이탈(빨강●, 아래로 뚫림) / 저항 돌파(에메랄드●, 위로 뚫음)
        markers.push({
          time: ev.time,
          position: isSupport ? "belowBar" : "aboveBar",
          shape: failed ? "circle" : (isSupport ? "arrowUp" : "arrowDown"),
          color: failed
            ? (isSupport ? T.events.breakDown : T.events.breakUp)
            : (isSupport ? T.events.support : T.events.resistance),
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
        `<td>${s.insufficientData ? TR("데이터 부족", "no data") : s.touches}</td>` +
        `<td>${s.supportBounces}</td><td>${s.resistanceBounces}</td>` +
        `<td>${s.breaks}</td><td>${s.undecided}</td>` +
        `<td>${rate}</td><td>${Number(s.score).toFixed(3)}</td>` +
        `<td>${esc(s.lastTouch || "—")}</td>`;
      el.statsBody.appendChild(tr);
    });
  }
})();
