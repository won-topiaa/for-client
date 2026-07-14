/* 차트 패턴 스크리너 프런트엔드 */
(function () {
  "use strict";

  // 라이트/다크 자동 대응 차트 테마 (에메랄드=상승 · 빨강=하락, 사이트 공통 규약)
  const darkMq = window.matchMedia("(prefers-color-scheme: dark)");
  function chartTheme() {
    const dark = darkMq.matches;
    return {
      text: dark ? "#a1a1aa" : "#71717a",
      grid: dark ? "rgba(39,39,42,.6)" : "rgba(228,228,231,.8)",
      border: dark ? "#27272a" : "#e4e4e7",
      up: dark ? "#34d399" : "#059669",
      down: dark ? "#f87171" : "#dc2626",
      // 오버레이(넥라인·추세선 등): 캔들과 겹치지 않는 인디고·앰버·시안 계열
      overlays: dark ? ["#818cf8", "#fbbf24", "#22d3ee"]
                     : ["#4f46e5", "#d97706", "#0891b2"],
    };
  }

  // 각 패턴의 간략한 설명 (선택 시 결과 맨 위에 표시)
  const DESCRIPTIONS = {
    stage2:
      "<b>와인스타인 초기 2단계란?</b> 주가가 「① 바닥 다지기 → ② 상승 → ③ 천장 다지기 → ④ 하락」을 " +
      "순환한다는 스탠 와인스타인(1988)의 이론에서, 수익 기대가 가장 큰 지점은 <b>1단계 박스권을 강한 " +
      "거래량과 함께 위로 뚫고 30주 이동평균선이 막 상승으로 돌아선 직후</b>입니다. 이 스크리너는 그의 실전 " +
      "기준을 그대로 적용합니다: ① 베이스 상단을 최근 60일 내 첫 돌파 ② 돌파 거래량이 베이스 평균의 " +
      "1.3배 이상(2배 이상이 교과서적) ③ 30주선이 하락·횡보에서 신선하게 상승 전환 ④ 돌파선 대비 " +
      "+25% 이내(추격 매수 배제) ⑤ 시장 지수 대비 상대강도(RS) 가점.<br>" +
      "<b>자동 탈락:</b> 종가가 30주선 아래로 내려가거나(와인스타인의 매도 규칙), 돌파선보다 3% 넘게 " +
      "되밀리거나(실패 돌파), 돌파선 대비 +25% 를 넘어 이미 확장되면 다음 스캔에서 목록에서 빠집니다." +
      "<span class='src'>기준 출처: Stan Weinstein, 「Secrets for Profiting in Bull and Bear Markets」</span>",
    triangle:
      "<b>삼각수렴이란?</b> 고점은 점점 낮아지고 저점은 점점 높아지며 가격 변동폭이 좁아지는 패턴입니다. " +
      "매수·매도 세력이 팽팽하게 균형을 이루다가 <b>꼭짓점 부근에서 균형이 깨지며 돌파 방향으로 큰 움직임</b>이 " +
      "나오는 경향이 있어, '에너지 응축' 구간으로 봅니다. 고점 수평+저점 상승은 상승 삼각형(상방 우세), " +
      "고점 하락+저점 수평은 하락 삼각형(하방 우세), 양쪽 다 좁아지면 대칭 삼각형(방향 중립)으로 구분합니다.<br>" +
      "<b>자동 탈락:</b> 종가가 추세선 밖으로 ATR(평균 변동폭) 이상 이탈하면 돌파가 끝난 것으로 보고 " +
      "제외합니다. 또 돌파 없이 꼭짓점까지 85% 이상 수렴해 버린 삼각형도 제외합니다 — 실증 연구상 " +
      "돌파는 평균적으로 꼭짓점까지 73~75% 지점에서 나오며, 꼭짓점에 닿도록 못 뚫으면 실패 경향이 있습니다." +
      "<span class='src'>탈락 기준 출처: Thomas Bulkowski, 「Encyclopedia of Chart Patterns」 (2005)</span>",
    head_shoulders:
      "<b>헤드 앤 숄더란?</b> 상승 추세의 끝에서 나타나는 대표적 천장형 반전 패턴입니다. 가운데가 가장 높은 " +
      "세 개의 봉우리(어깨-머리-어깨)를 만들고, 두 되돌림 저점을 이은 <b>넥라인을 아래로 이탈하면 하락 반전 " +
      "신호</b>로 봅니다. 학술 연구(Lo·Mamaysky·Wang 2000)에서도 통계적 정보력이 확인된 패턴입니다. " +
      "여기서는 넥라인 접근 중이거나 이탈 직후(=지금 의미 있는) 형태만 보여줍니다.<br>" +
      "<b>자동 탈락:</b> 넥라인 이탈(완성) <b>시점</b>을 추적해 판정합니다 — ① 종가가 머리 위로 회복하면 " +
      "무효(busted, Bulkowski 2005) ② 완성 후 10봉이 지나면 신호 소진 (정보력은 완성 직후 집중 — " +
      "Lo·Mamaysky·Wang 2000 · 되돌림도 평균 ~10일 내 — Bulkowski) ③ 완성 후 종가가 넥라인 위로 " +
      "2% 넘게 회복하면 실패 돌파로 무효 (정상 되돌림은 넥라인 부근까지) ④ 이탈 방향으로 5% 넘게 " +
      "진행됐으면 진입 늦음(5% 룰). 완성됐다가 가격이 회복해도 목록에 되살아나지 않습니다." +
      "<span class='src'>탈락 기준 출처: Bulkowski (2005) · Lo·Mamaysky·Wang (2000, Journal of Finance)</span>",
    inv_head_shoulders:
      "<b>역헤드 앤 숄더란?</b> 헤드 앤 숄더를 뒤집은 바닥형 반전 패턴입니다. 하락 추세 끝에서 가운데가 가장 " +
      "깊은 세 개의 골(어깨-머리-어깨)을 만들고, <b>넥라인을 위로 돌파하면 상승 반전 신호</b>로 봅니다. " +
      "머리에서 거래량이 줄고 돌파에서 거래량이 늘면 신뢰도가 높아지는 것으로 알려져 있습니다.<br>" +
      "<b>자동 탈락:</b> 넥라인 돌파(완성) <b>시점</b>을 추적해 판정합니다 — ① 종가가 머리(최저점) 아래로 " +
      "내려가면 무효(busted) ② 완성 후 10봉 경과 시 신호 소진 ③ 완성 후 종가가 넥라인 아래로 2% 넘게 " +
      "되밀리면 실패 돌파로 무효 ④ 돌파 방향으로 5% 넘게 진행됐으면 진입 늦음(5% 룰)." +
      "<span class='src'>탈락 기준 출처: Bulkowski (2005) · Lo·Mamaysky·Wang (2000, Journal of Finance)</span>",
    cup_handle:
      "<b>컵 앤 핸들이란?</b> 고점에서 완만하게 하락했다가 둥근 바닥을 그리며 회복하는 '컵'과, 이전 고점 " +
      "부근에서의 얕은 되돌림 '핸들'로 이루어진 상승 지속 패턴입니다 (윌리엄 오닐이 대중화). " +
      "<b>핸들 상단(컵 테두리) 돌파를 매수 신호</b>로 보며, V자 반등이 아니라 둥근 바닥일수록, 핸들 조정이 " +
      "얕을수록 교과서적입니다. 여기서는 2차곡선 적합도로 '둥근 정도'를 수치화해 V자를 걸러냅니다.<br>" +
      "<b>자동 탈락:</b> 핸들 조정이 컵 깊이의 절반 또는 15% 를 넘으면 무효(오닐의 핸들 규칙 — 핸들은 " +
      "컵 상반부에 있어야 함), 테두리 대비 -15% 아래로 무너지면 패턴 실패, 테두리 +5% 를 넘어 이미 " +
      "상승했으면 추격 구간이라 제외합니다 (오닐: 매수는 피벗 +5% 이내에서만)." +
      "<span class='src'>탈락 기준 출처: William O'Neil, 「How to Make Money in Stocks」</span>",
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
    status: document.getElementById("scanStatus"),
    matches: document.getElementById("matches"),
    party: document.getElementById("scanParty"),
    partyCaption: document.getElementById("partyCaption"),
    sr: document.getElementById("srStatus"),
  };

  // 로딩 카드: tips.js 의 한입 지식(전일 시장·패턴 사전·이론·명언·매크로)을
  // 7초에 한 장씩 돌려 보여준다 (두 줄까지 읽을 시간)
  const TIP_INTERVAL_MS = 7000;
  let captionTimer = null;

  function showTip() {
    const t = window.LoadingTips && window.LoadingTips.next();
    if (!t) { // tips.js 로드 실패 시 안전한 기본 문구
      el.partyCaption.textContent = "양봉이와 음봉이가 차트를 살펴보는 중…";
      return;
    }
    el.partyCaption.innerHTML =
      `<span class="tip-tag">${esc(t.tag)}</span>${esc(t.text)}`;
  }

  function showParty(on) {
    el.party.style.display = on ? "flex" : "none";
    el.partyCaption.style.display = on ? "block" : "none";
    if (on) {
      // 폴링(2초)마다 다시 호출돼도 타이머를 새로 만들지 않아야
      // 카드 로테이션이 실제로 돌아간다
      if (!captionTimer) {
        showTip();
        captionTimer = setInterval(showTip, TIP_INTERVAL_MS);
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
  let lastFp = null; // 직전 렌더의 지문 — 같은 결과 재렌더(깜빡임) 방지
  let pollFails = 0; // 연속 폴링 실패 횟수 (일시 오류는 재시도, 지속 오류만 포기)
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


  // 스크린리더 알림: 폴링마다 재잘대지 않도록 시작/완료/실패 같은
  // 굵직한 전환만, 같은 문장은 반복하지 않고 알린다
  let lastAnnounced = "";
  let suppressAnnounce = false; // 테마 재렌더는 상태 변화가 아니므로 침묵
  function announce(msg) {
    if (!el.sr || suppressAnnounce || msg === lastAnnounced) return;
    lastAnnounced = msg;
    el.sr.textContent = msg;
  }

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
      announce("종목 스캔을 시작했습니다. 완료되면 알려드립니다.");
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
      lastBody = null;
      lastFp = null;
      showParty(false); // 이전 스캔의 봇+캡션이 스피너와 겹쳐 보이지 않게
      el.status.innerHTML = '<span class="spinner"></span>패턴 스캔 중…';
    }
    try {
      const r = await fetch(`/api/patterns?pattern=${pattern}&market=${market}`);
      if (seq !== reqSeq) return;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      if (seq !== reqSeq) return;
      pollFails = 0;
      if (body.status === "running") {
        if (lastBody) {
          // 서버 재시작 등으로 done -> running 으로 되돌아간 경우: 이전 결과 정리
          destroyCharts();
          el.matches.innerHTML = "";
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
        destroyCharts();
        el.matches.innerHTML = "";
        lastBody = null; // 테마 변경 시 지워진 옛 결과가 되살아나지 않게
        lastFp = null;
        el.status.textContent = body.detail || "스캔 실패 — 잠시 후 다시 시도해 주세요.";
        announce(el.status.textContent);
        pollTimer = setTimeout(() => load(true), 15000); // 서버 쿨다운 후 자동 재시도
        return;
      }
      showParty(false);
      if (isPoll && renderedWhileRefreshing && body.refreshing) {
        // 만료 결과는 이미 그려둠 — 재스캔이 끝날 때까지 다시 그리지 않고 대기
        pollTimer = setTimeout(() => load(true), 5000);
        return;
      }
      const fp = JSON.stringify([body.generatedAt, body.scanned, body.elapsedSec, body.universe,
        body.totalMatches, body.matches.length && body.matches[0].symbol,
        body.refreshing, body.partial]);
      // 부분 결과이거나 갱신 중이면 빠르게(5초) 폴링해 채워지는 대로 받아본다
      const keepAlive = (body.refreshing || body.partial) ? 5000 : 5 * 60 * 1000;
      if (isPoll && fp === lastFp) {
        // 내용이 그대로면 재렌더(차트 재생성) 없이 다음 keep-alive 만 예약
        pollTimer = setTimeout(() => load(true), keepAlive);
        return;
      }
      render(body);
      // 지문은 렌더가 '성공한 뒤'에만 확정한다 — 렌더 도중 예외가 나면
      // (예: 차트 라이브러리 로드 실패) 다음 폴이 같은 지문에 막혀
      // 고장난 화면이 5분 keep-alive 에 갇히는 것을 방지
      lastFp = fp;
      renderedWhileRefreshing = !!body.refreshing;
      pollTimer = setTimeout(() => load(true), keepAlive);
    } catch (err) {
      if (seq !== reqSeq) return;
      // 폴링 중 일시적 네트워크 오류로 체인을 끊지 않는다 — 3회까지 재시도
      if (isPoll && pollFails < 3) {
        pollFails += 1;
        pollTimer = setTimeout(() => load(true), 4000);
        return;
      }
      showParty(false);
      // 테마 전환 재렌더가 "백그라운드 갱신 중"이라고 거짓 표시하지 않게 정리
      if (lastBody) lastBody.refreshing = false;
      renderedWhileRefreshing = false;
      lastFp = null; // 회복 폴이 실패 문구를 확실히 걷어내도록 재렌더 강제
      el.status.textContent = "스캔 실패: " + err.message;
      announce(el.status.textContent);
      // 체인을 죽이지 않고 느리게 재시도 (네트워크 복구 시 자동 회복)
      pollTimer = setTimeout(() => { pollFails = 0; load(true); }, 30000);
    }
  }

  // OS 테마가 바뀌면 마지막 결과를 새 팔레트로 다시 그린다
  let lastBody = null;
  function onThemeChange() {
    if (!lastBody) return;
    // 포기-대기 중(30초 재시도) 표시된 실패 문구가 덮이지 않게 보존.
    // 스크린리더에도 '스캔 완료'가 잘못 나가지 않게 재렌더 동안 침묵
    // (lastAnnounced 를 오염시키면 진짜 회복 알림이 중복 제거로 묻힌다)
    const statusText = el.status.textContent;
    suppressAnnounce = true;
    try {
      render(lastBody);
    } finally {
      suppressAnnounce = false;
    }
    el.status.textContent = statusText;
  }
  if (darkMq.addEventListener) darkMq.addEventListener("change", onThemeChange);
  else if (darkMq.addListener) darkMq.addListener(onThemeChange);

  function render(body) {
    lastBody = body;
    destroyCharts();
    el.matches.innerHTML = "";
    el.status.textContent =
      `${body.scanned}개 종목 ${body.partial ? "스캔" : "스캔 완료"} · 매칭 ${body.totalMatches}개` +
      (body.totalMatches > body.matches.length
        ? ` (상위 ${body.matches.length}개 표시)` : "") +
      (body.partial ? " · 남은 종목 계속 확인 중…"
        : body.refreshing ? " · 백그라운드에서 새 스캔 진행 중" : "");
    announce(el.status.textContent); // 시작을 알렸으니 완료도 알린다
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
        `<a class="m-link" href="/ma?symbol=${encodeURIComponent(m.symbol)}">이평선 분석 →</a></span>` +
        `</div>` +
        `<div class="m-summary">${esc(m.summary)}</div>` +
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
    (m.overlays || []).forEach((ov, i) => {
      const line = chart.addSeries(LWC.LineSeries, {
        color: T.overlays[i % T.overlays.length],
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
