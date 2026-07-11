/* 차트 패턴 스크리너 프런트엔드 */
(function () {
  "use strict";

  const OVERLAY_COLORS = ["#f59e0b", "#a78bfa", "#22d3ee"];

  // 각 패턴의 간략한 설명 (선택 시 결과 맨 위에 표시)
  const DESCRIPTIONS = {
    stage2:
      "<b>와인스타인 초기 2단계란?</b> 주가가 「① 바닥 다지기 → ② 상승 → ③ 천장 다지기 → ④ 하락」을 " +
      "순환한다는 스탠 와인스타인(1988)의 이론에서, 수익 기대가 가장 큰 지점은 <b>1단계 박스권을 강한 " +
      "거래량과 함께 위로 뚫고 30주 이동평균선이 막 상승으로 돌아선 직후</b>입니다. 이 스크리너는 그의 실전 " +
      "기준을 그대로 적용합니다: ① 베이스 상단을 최근 60일 내 첫 돌파 ② 돌파 거래량이 베이스 평균의 " +
      "1.3배 이상(2배 이상이 교과서적) ③ 30주선이 하락·횡보에서 신선하게 상승 전환 ④ 돌파선 대비 " +
      "+25% 이내(추격 매수 배제) ⑤ 시장 지수 대비 상대강도(RS) 가점." +
      "<span class='src'>기준 출처: Stan Weinstein, 「Secrets for Profiting in Bull and Bear Markets」</span>",
    triangle:
      "<b>삼각수렴이란?</b> 고점은 점점 낮아지고 저점은 점점 높아지며 가격 변동폭이 좁아지는 패턴입니다. " +
      "매수·매도 세력이 팽팽하게 균형을 이루다가 <b>꼭짓점 부근에서 균형이 깨지며 돌파 방향으로 큰 움직임</b>이 " +
      "나오는 경향이 있어, '에너지 응축' 구간으로 봅니다. 고점 수평+저점 상승은 상승 삼각형(상방 우세), " +
      "고점 하락+저점 수평은 하락 삼각형(하방 우세), 양쪽 다 좁아지면 대칭 삼각형(방향 중립)으로 구분합니다.",
    head_shoulders:
      "<b>헤드 앤 숄더란?</b> 상승 추세의 끝에서 나타나는 대표적 천장형 반전 패턴입니다. 가운데가 가장 높은 " +
      "세 개의 봉우리(어깨-머리-어깨)를 만들고, 두 되돌림 저점을 이은 <b>넥라인을 아래로 이탈하면 하락 반전 " +
      "신호</b>로 봅니다. 학술 연구(Lo·Mamaysky·Wang 2000)에서도 통계적 정보력이 확인된 패턴입니다. " +
      "여기서는 넥라인 부근까지 온(=지금 의미 있는) 형태만 보여줍니다.",
    inv_head_shoulders:
      "<b>역헤드 앤 숄더란?</b> 헤드 앤 숄더를 뒤집은 바닥형 반전 패턴입니다. 하락 추세 끝에서 가운데가 가장 " +
      "깊은 세 개의 골(어깨-머리-어깨)을 만들고, <b>넥라인을 위로 돌파하면 상승 반전 신호</b>로 봅니다. " +
      "머리에서 거래량이 줄고 돌파에서 거래량이 늘면 신뢰도가 높아지는 것으로 알려져 있습니다.",
    cup_handle:
      "<b>컵 앤 핸들이란?</b> 고점에서 완만하게 하락했다가 둥근 바닥을 그리며 회복하는 '컵'과, 이전 고점 " +
      "부근에서의 얕은 되돌림 '핸들'로 이루어진 상승 지속 패턴입니다 (윌리엄 오닐이 대중화). " +
      "<b>핸들 상단(컵 테두리) 돌파를 매수 신호</b>로 보며, V자 반등이 아니라 둥근 바닥일수록, 핸들 조정이 " +
      "얕을수록 교과서적입니다. 여기서는 2차곡선 적합도로 '둥근 정도'를 수치화해 V자를 걸러냅니다.",
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  const el = {
    cards: document.getElementById("patternCards"),
    marketToggle: document.getElementById("marketToggle"),
    desc: document.getElementById("patternDesc"),
    status: document.getElementById("status"),
    matches: document.getElementById("matches"),
    party: document.getElementById("scanParty"),
    partyCaption: document.getElementById("partyCaption"),
  };

  const CAPTIONS = [
    "양봉이와 음봉이가 차트를 뒤지는 중…",
    "박스권 상단을 두드려보는 중…",
    "30주선 기울기를 재보는 중…",
    "거래량 급증을 킁킁 맡는 중…",
    "넥라인을 자로 대보는 중…",
  ];
  let captionIdx = 0;
  let captionTimer = null;

  function showParty(on) {
    el.party.style.display = on ? "flex" : "none";
    el.partyCaption.style.display = on ? "block" : "none";
    if (on) {
      // 폴링(2초)마다 다시 호출돼도 타이머를 새로 만들지 않아야
      // 자막 로테이션(3.5초)이 실제로 돌아간다
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

  let pattern = "stage2";
  let market = "kr";
  let pollTimer = null;
  let reqSeq = 0;
  let renderedWhileRefreshing = false; // 만료 결과를 보여주며 재스캔 대기 중인지
  const charts = [];

  function activateCard(card) {
    pattern = card.dataset.pattern;
    Array.from(el.cards.children).forEach((c) => {
      c.classList.toggle("active", c === card);
      c.setAttribute("aria-pressed", c === card ? "true" : "false");
    });
    load();
  }

  el.cards.addEventListener("click", (e) => {
    const card = e.target.closest(".p-card");
    if (card) activateCard(card);
  });
  el.cards.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest(".p-card");
    if (!card) return;
    e.preventDefault();
    activateCard(card);
  });

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

  function renderDesc() {
    el.desc.innerHTML = DESCRIPTIONS[pattern] || "";
  }

  // 진행률 갱신: 기존 막대 DOM 을 재사용해야 폭 전환(transition)이 자연스럽고
  // 폴링마다 화면이 깜빡이지 않는다
  function updateProgress(body) {
    const label =
      `${market === "kr" ? "국내" : "미국"} 종목 스캔 중… ` +
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
      // 사용자가 패턴/시장을 바꾼 경우에만 화면을 비운다 (폴링 중엔 유지)
      destroyCharts();
      el.matches.innerHTML = "";
      renderDesc();
      renderedWhileRefreshing = false;
      el.status.innerHTML = '<span class="spinner"></span>패턴 스캔 중…';
    }
    try {
      const r = await fetch(`/api/patterns?pattern=${pattern}&market=${market}`);
      if (seq !== reqSeq) return;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      if (seq !== reqSeq) return;
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
        el.status.textContent = body.detail || "스캔 실패 — 잠시 후 다시 시도해 주세요.";
        pollTimer = setTimeout(() => load(true), 15000); // 서버 쿨다운 후 자동 재시도
        return;
      }
      showParty(false);
      if (isPoll && renderedWhileRefreshing && body.refreshing) {
        // 만료 결과는 이미 그려둠 — 재스캔이 끝날 때까지 다시 그리지 않고 대기
        pollTimer = setTimeout(() => load(true), 5000);
        return;
      }
      render(body);
      renderedWhileRefreshing = !!body.refreshing;
      if (body.refreshing) pollTimer = setTimeout(() => load(true), 5000);
    } catch (err) {
      if (seq === reqSeq) {
        showParty(false);
        el.status.textContent = "스캔 실패: " + err.message;
      }
    }
  }

  function render(body) {
    destroyCharts();
    el.matches.innerHTML = "";
    el.status.textContent =
      `${body.scanned}개 종목 스캔 완료 · 매칭 ${body.totalMatches}개` +
      (body.totalMatches > body.matches.length
        ? ` (상위 ${body.matches.length}개 표시)` : "") +
      (body.refreshing ? " · 백그라운드에서 새 스캔 진행 중" : "");
    if (!body.matches.length) {
      el.matches.innerHTML =
        `<div class="empty">지금 이 패턴에 해당하는 종목이 없습니다.<br>` +
        `<span style="font-size:12px">패턴은 시장 상황에 따라 나타났다 사라집니다 — 다른 패턴/시장을 보거나 나중에 다시 확인해 보세요.</span></div>`;
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
        lineWidth: 2, lineStyle: ov.name && (ov.name.includes("넥") || ov.name.includes("상단")) ? 1 : 0,
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
