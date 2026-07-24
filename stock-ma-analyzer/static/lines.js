/* 내 이평선 스크리너 프런트엔드 — 기간 입력 + 지지/저항 두 리스트 */
(function () {
  "use strict";

  // 라이트/다크 자동 대응 차트 테마 (사이트 공통 규약)
  const darkMq = window.matchMedia("(prefers-color-scheme: dark)");
  function chartTheme() {
    const forced = document.documentElement.dataset.theme;
    const dark = forced === "dark" || (forced !== "light" && darkMq.matches);
    return {
      text: dark ? "#a1a1aa" : "#71717a",
      grid: dark ? "rgba(39,39,42,.6)" : "rgba(228,228,231,.8)",
      border: dark ? "#27272a" : "#e4e4e7",
      up: dark ? "#34d399" : "#059669",
      down: dark ? "#f87171" : "#dc2626",
      maLine: dark ? "#fbbf24" : "#d97706",   // 조회한 이평선 (앰버)
      marker: dark ? "#818cf8" : "#4f46e5",   // 최근 터치 표시 (인디고)
    };
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  const el = {
    marketToggle: document.getElementById("marketToggle"),
    controls: document.getElementById("lineControls"),
    periodInput: document.getElementById("periodInput"),
    goBtn: document.getElementById("goBtn"),
    status: document.getElementById("scanStatus"),
    supTitle: document.getElementById("supTitle"),
    resTitle: document.getElementById("resTitle"),
    supportList: document.getElementById("supportList"),
    resistList: document.getElementById("resistList"),
    party: document.getElementById("scanParty"),
    partyCaption: document.getElementById("partyCaption"),
    partyNote: document.getElementById("partyNote"),
    sr: document.getElementById("srStatus"),
  };

  const TIP_INTERVAL_MS = 7000;
  let captionTimer = null;

  function showTip() {
    const t = window.LoadingTips && window.LoadingTips.next();
    if (!t) {
      el.partyCaption.textContent = "양봉이와 음봉이가 이평선을 대보는 중…";
      return;
    }
    el.partyCaption.innerHTML =
      `<span class="tip-tag">${esc(t.tag)}</span>${esc(t.text)}`;
  }

  function showParty(on) {
    el.party.style.display = on ? "flex" : "none";
    el.partyCaption.style.display = on ? "block" : "none";
    if (el.partyNote) el.partyNote.style.display = on ? "block" : "none";
    if (on) {
      if (!captionTimer) {
        showTip();
        captionTimer = setInterval(showTip, TIP_INTERVAL_MS);
      }
    } else if (captionTimer) {
      clearInterval(captionTimer);
      captionTimer = null;
    }
  }

  let market = "kr";
  let period = 20;
  let pollTimer = null;
  let reqSeq = 0;
  let renderedWhileRefreshing = false;
  let lastFp = null;
  let pollFails = 0;
  let inFlight = false; // fetch 진행 중 표시 — 수동 재조회의 중복 발사 방지
  const charts = [];
  // 첫 공개 최소 로딩 (패턴·터치 페이지와 동일한 규약): 결과가 즉시 와도
  // 잠깐 스캔 애니메이션을 보여줘 '실제 계산' 신뢰를 준다. 첫 진입만 길게.
  let revealed = false;
  let firstReveal = true;
  let loadStartMs = 0;
  const nowMs = () => (window.performance && performance.now
    ? performance.now() : Date.now());
  function minRevealMs() {
    return firstReveal ? 3000 + Math.random() * 1800   // 첫 진입 3.0~4.8초
                       : 1200 + Math.random() * 800;   // 전환 1.2~2.0초
  }

  function clampPeriod(v) {
    // Number("") === 0 이라 빈칸이 조용히 5일선으로 둔갑한다 — 명시적으로 거른다
    if (String(v).trim() === "") return null;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return null;
    return Math.max(5, Math.min(250, n));
  }

  function syncPresets() {
    el.controls.querySelectorAll(".preset").forEach((b) => {
      b.classList.toggle("active", Number(b.dataset.period) === period);
    });
  }

  function applyPeriodAndLoad() {
    // type=number 는 '12e' 같은 미완성 입력을 value="" 로 보고한다 — badInput
    // 이면 clamp 를 건너뛰고 안내 문구를 보여준다
    const bad = el.periodInput.validity && el.periodInput.validity.badInput;
    const p = bad ? null : clampPeriod(el.periodInput.value);
    if (p === null) {
      el.status.textContent = "이평선 기간은 5~250 사이 숫자로 입력해 주세요.";
      announce(el.status.textContent);
      return;
    }
    el.periodInput.value = p;
    if (p !== period) {
      period = p;
      syncPresets();
      load();
    } else {
      syncPresets();
      // 같은 값 수동 재조회(오류·429 대기 중 재시도, 완료 후 새로고침) —
      // 단 같은 요청이 이미 날아가 있는 중이면 중복 발사하지 않는다
      if (!inFlight) load();
    }
  }

  el.marketToggle.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-market]");
    if (!btn || btn.dataset.market === market) return; // 같은 시장 재클릭 무시
    market = btn.dataset.market;
    Array.from(el.marketToggle.children).forEach((b) => {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-pressed", b === btn ? "true" : "false");
    });
    load();
  });

  el.controls.addEventListener("click", (e) => {
    const preset = e.target.closest(".preset");
    if (preset) {
      el.periodInput.value = preset.dataset.period;
      applyPeriodAndLoad();
    }
  });
  el.goBtn.addEventListener("click", applyPeriodAndLoad);
  el.periodInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyPeriodAndLoad();
  });

  let lastAnnounced = "";
  let suppressAnnounce = false;
  function announce(msg) {
    if (!el.sr || suppressAnnounce || msg === lastAnnounced) return;
    lastAnnounced = msg;
    el.sr.textContent = msg;
  }

  function destroyCharts() {
    charts.forEach((c) => c.remove());
    charts.length = 0;
  }

  function clearLists() {
    destroyCharts();
    el.supportList.innerHTML = "";
    el.resistList.innerHTML = "";
    el.supTitle.style.display = "none";
    el.resTitle.style.display = "none";
  }

  function matchFp(body) {
    return JSON.stringify([
      body.period, body.totalSupport, body.totalResistance,
      !!body.refreshing, !!body.partial,
      (body.support || []).map((m) => [m.symbol, m.maScore, m.distPct]),
      (body.resistance || []).map((m) => [m.symbol, m.maScore, m.distPct]),
    ]);
  }

  function statusText(body) {
    return `${body.scanned}개 종목 ${body.partial ? "백테스트" : "백테스트 완료"} · ` +
      `${body.period}일선 지지 ${body.totalSupport}개 · 저항 ${body.totalResistance}개` +
      (body.partial ? " · 남은 종목 계속 확인 중…"
        : body.refreshing ? " · 백그라운드에서 새 스캔 진행 중" : "");
  }

  function updateProgress(body) {
    const label =
      `${market === "kr" ? "국내" : "미국"} 종목에 ${period}일선을 대보는 중… ` +
      (body.total ? `${body.done}/${body.total} 종목` : "대상 선정 중");
    const pct = body.total ? Math.round((body.done / body.total) * 100) : 0;
    let bar = el.status.querySelector(".bar > div");
    if (!bar) {
      el.status.innerHTML =
        `<span class="scan-label"></span><div class="bar"><div style="width:0%"></div></div>`;
      bar = el.status.querySelector(".bar > div");
      announce("종목 스캔을 시작했습니다. 완료되면 알려드립니다.");
    }
    el.status.querySelector(".scan-label").textContent = label;
    bar.style.width = pct + "%";
  }

  // 응답이 중간에 멈추면(스톨) fetch/json 이 영원히 대기해 폴링 체인이
  // 소리 없이 죽는다 — 타임아웃으로 거부시켜 catch 의 재시도 사다리로 보낸다.
  const FETCH_TIMEOUT_MS = 15000;
  function pollSignal() {
    return (typeof AbortSignal !== "undefined" && AbortSignal.timeout)
      ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
  }

  async function load(isPoll) {
    const seq = ++reqSeq;
    clearTimeout(pollTimer);
    pollTimer = null;
    inFlight = true;
    if (!isPoll) {
      clearLists();
      renderedWhileRefreshing = false;
      lastBody = null;
      lastFp = null;
      revealed = false;
      loadStartMs = nowMs();
      showParty(true); // 처음부터 스캔 애니메이션 (최소 로딩 신뢰 효과)
      el.status.innerHTML = `<span class="spinner"></span>${period}일선 스캔 준비 중…`;
    }
    try {
      const r = await fetch(`/api/lines?market=${market}&period=${period}`,
                            { signal: pollSignal() });
      if (seq !== reqSeq) return;
      if (r.status === 401) {  // 세션 만료 등 — 로그인 페이지로
        location.href = "/login?next=%2Flines";
        return;
      }
      if (r.status === 429) {  // 스캐너 슬롯 가득 — 잠시 뒤 자동 재시도
        el.status.textContent =
          "지금 다른 이평선 스캔이 많아요 — 잠시 후 자동으로 다시 시도합니다.";
        announce(el.status.textContent);
        pollTimer = setTimeout(() => load(true), 10000);
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      if (seq !== reqSeq) return;
      pollFails = 0;
      if (body.status === "running") {
        if (lastBody) {
          clearLists();
          lastBody = null;
          lastFp = null;
          renderedWhileRefreshing = false;
        }
        showParty(true);
        updateProgress(body);
        pollTimer = setTimeout(() => load(true), 2000);
        return;
      }
      if (body.status === "error") {
        showParty(false);
        clearLists();
        lastBody = null;
        lastFp = null;
        el.status.textContent = body.detail || "스캔 실패 — 잠시 후 다시 시도해 주세요.";
        announce(el.status.textContent);
        pollTimer = setTimeout(() => load(true), 15000);
        return;
      }
      const fp = matchFp(body);
      const keepAlive = (body.refreshing || body.partial) ? 5000 : 30 * 60 * 1000;
      // 첫 공개 최소 로딩 (패턴·터치와 동일) — 준비된 결과라도 잠깐 연출
      if (!revealed) {
        revealed = true;
        const wait = Math.max(0, minRevealMs() - (nowMs() - loadStartMs));
        firstReveal = false;
        if (wait > 0) {
          showParty(true);
          pollTimer = setTimeout(() => {
            if (seq !== reqSeq) return; // 그새 시장/기간을 바꿨으면 폐기
            let nextMs = keepAlive;
            try {
              showParty(false);
              render(body);
              lastFp = fp;
              renderedWhileRefreshing = !!body.refreshing;
            } catch (e2) {
              lastFp = null;   // 재렌더 강제
              nextMs = 4000;   // 곧 회복 폴
            }
            pollTimer = setTimeout(() => load(true), nextMs);
          }, wait);
          return;
        }
      }
      showParty(false);
      if (isPoll && renderedWhileRefreshing && body.refreshing && !body.partial) {
        el.status.textContent = statusText(body);
        pollTimer = setTimeout(() => load(true), 5000);
        return;
      }
      if (isPoll && fp === lastFp) {
        el.status.textContent = statusText(body);
        pollTimer = setTimeout(() => load(true), keepAlive);
        return;
      }
      render(body);
      lastFp = fp;
      renderedWhileRefreshing = !!body.refreshing;
      pollTimer = setTimeout(() => load(true), keepAlive);
    } catch (err) {
      if (seq !== reqSeq) return;
      if (isPoll && pollFails < 3) {
        pollFails += 1;
        pollTimer = setTimeout(() => load(true), 4000);
        return;
      }
      showParty(false);
      if (lastBody) lastBody.refreshing = false;
      renderedWhileRefreshing = false;
      lastFp = null;
      el.status.textContent = "스캔 실패: " + err.message;
      announce(el.status.textContent);
      pollTimer = setTimeout(() => { pollFails = 0; load(true); }, 30000);
    } finally {
      // 더 새 요청이 이미 떠 있으면(seq 추월) 그쪽 표시를 건드리지 않는다
      if (seq === reqSeq) inFlight = false;
    }
  }

  // OS 테마가 바뀌면 마지막 결과를 새 팔레트로 다시 그린다
  let lastBody = null;
  function onThemeChange() {
    if (!lastBody) return;
    const statusKeep = el.status.textContent;
    suppressAnnounce = true;
    try {
      render(lastBody);
    } finally {
      suppressAnnounce = false;
    }
    el.status.textContent = statusKeep;
  }
  document.addEventListener("wt-themechange", onThemeChange);

  function sideCard(m, side) {
    const card = document.createElement("div");
    card.className = "m-card";
    const rate = (m.respectRate * 100).toFixed(0);
    const dist = m.distPct > 0 ? `+${m.distPct}%` : `${m.distPct}%`;
    const label = side === "support" ? "지지" : "저항";
    card.innerHTML =
      `<div class="m-head">` +
      `<span><span class="m-name">${esc(m.name)}</span> ` +
      `<span class="m-code">${esc(m.symbol)}${m.market ? " · " + esc(m.market) : ""}</span></span>` +
      `<span><span class="ma-chip">MA ${esc(m.period)}</span> ` +
      `<a class="m-link" href="/ma?symbol=${encodeURIComponent(m.symbol)}">이평선 분석 →</a></span>` +
      `</div>` +
      `<div class="m-meter" role="img" aria-label="3년 ${label} 성공률 ${esc(rate)}%">` +
      `<span style="width:${Math.max(0, Math.min(100, Number(rate) || 0))}%"></span></div>` +
      `<div class="m-summary">3년 ${label} 성공률 <b>${esc(rate)}%</b> (결정 ${esc(m.decided)}회 · 터치 ${esc(m.touches)}회) · ` +
      `종가는 선 대비 <b>${esc(dist)}</b> · 선 기울기 ${m.slopePct > 0 ? "+" : ""}${esc(m.slopePct)}%</div>` +
      `<div class="m-chart"></div>`;
    return card;
  }

  function renderList(listEl, titleEl, items, total, side, partial) {
    listEl.innerHTML = "";
    titleEl.style.display = "flex";
    titleEl.querySelector(".t").textContent =
      side === "support" ? `${period}일선 지지를 받는 중` : `${period}일선 저항을 받는 중`;
    titleEl.querySelector(".cnt").textContent =
      total > items.length ? `${total}개 중 상위 ${items.length}개` : `${total}개`;
    if (!items.length) {
      listEl.innerHTML = partial
        ? `<div class="empty">남은 종목을 확인하는 중입니다…</div>`
        : `<div class="empty">${period}일선 ${side === "support" ? "지지" : "저항"} 조건을 모두 만족하는 종목이 지금은 없습니다.<br>` +
          `<span style="font-size:12px">기간을 바꾸거나 다른 시장을 확인해 보세요 — 상태는 매일 달라집니다.</span></div>`;
      return;
    }
    items.forEach((m) => {
      const card = sideCard(m, side);
      listEl.appendChild(card);
      drawChart(card.querySelector(".m-chart"), m, side);
    });
  }

  function render(body) {
    lastBody = body;
    destroyCharts();
    el.status.textContent = statusText(body);
    if (!body.partial) announce(el.status.textContent);
    renderList(el.supportList, el.supTitle, body.support || [],
               body.totalSupport || 0, "support", !!body.partial);
    renderList(el.resistList, el.resTitle, body.resistance || [],
               body.totalResistance || 0, "resistance", !!body.partial);
  }

  function drawChart(container, m, side) {
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
    if (m.candles.length) {
      const last = m.candles[m.candles.length - 1].time;
      LWC.createSeriesMarkers(candles, [side === "support"
        ? { time: last, position: "belowBar", shape: "arrowUp", color: T.marker, size: 1, text: "지지 시험" }
        : { time: last, position: "aboveBar", shape: "arrowDown", color: T.marker, size: 1, text: "저항 시험" }]);
    }
    chart.timeScale().fitContent();
    charts.push(chart);
  }

  // 로그인 상태 표시 + 로그아웃 (회원 전용 페이지)
  (function initAuthBox() {
    const box = document.getElementById("authBox");
    const emailEl = document.getElementById("authEmail");
    const logoutBtn = document.getElementById("logoutBtn");
    if (!box || !emailEl || !logoutBtn) return;
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.email) {
          emailEl.textContent = d.email;
          emailEl.title = d.email;
          box.style.display = "inline-flex";
        }
      })
      .catch(() => {});
    logoutBtn.addEventListener("click", () => {
      logoutBtn.disabled = true;
      fetch("/api/auth/logout", { method: "POST" })
        .then(() => { location.href = "/"; })
        .catch(() => { location.href = "/"; });
    });
  })();

  syncPresets();
  load();
})();
