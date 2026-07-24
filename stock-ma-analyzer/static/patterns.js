/* 차트 패턴 스크리너 프런트엔드 */
(function () {
  "use strict";

  // 라이트/다크 자동 대응 차트 테마 (에메랄드=상승 · 빨강=하락, 사이트 공통 규약)
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
      "되밀리거나(실패 돌파), 돌파선 대비 +25% 를 넘어 이미 확장되면 다음 스캔에서 목록에서 빠집니다.<br>" +
      "<b>순위 = 정석 부합도(0~100점):</b> 통과한 종목들은 교과서 이상형에 얼마나 가까운지로 줄 세웁니다 — " +
      "① 돌파 거래량(베이스 평균의 2배 이상 만점 — 와인스타인 경험칙·오닐 최소 +40~50%) ② 지수 대비 상대강도가 " +
      "양수이며 상승 중(맨스필드 RS — 뒤처지는 종목은 0점) ③ 30주선 위 0~8% 위치 × 상승 기울기 ④ 30주선 " +
      "상승 전환 후 5주 이내(2단계 '초입'이 손익비 최적) ⑤ 돌파선 +5% 이내 매수 근접(오닐의 5% 룰) " +
      "⑥ 베이스의 타이트함과 막판 거래량 마름. 치명적 결함 하나가 평균에 묻히지 않도록 기하·산술평균을 혼합해 합산합니다." +
      "<span class='src'>기준 출처: Stan Weinstein, 「Secrets for Profiting in Bull and Bear Markets」 · William O'Neil, 「How to Make Money in Stocks」</span>",
    triangle:
      "<b>삼각수렴이란?</b> 고점은 점점 낮아지고 저점은 점점 높아지며 가격 변동폭이 좁아지는 패턴입니다. " +
      "매수·매도 세력이 팽팽하게 균형을 이루다가 <b>꼭짓점 부근에서 균형이 깨지며 돌파 방향으로 큰 움직임</b>이 " +
      "나오는 경향이 있어, '에너지 응축' 구간으로 봅니다. 고점 수평+저점 상승은 상승 삼각형(상방 우세), " +
      "고점 하락+저점 수평은 하락 삼각형(하방 우세), 양쪽 다 좁아지면 대칭 삼각형(방향 중립)으로 구분합니다.<br>" +
      "<b>자동 탈락:</b> 종가가 추세선 밖으로 ATR(평균 변동폭) 이상 이탈하면 돌파가 끝난 것으로 보고 " +
      "제외합니다. 또 돌파 없이 꼭짓점까지 85% 이상 수렴해 버린 삼각형도 제외합니다 — 실증 연구상 " +
      "돌파는 평균적으로 꼭짓점까지 73~75% 지점에서 나오며, 꼭짓점에 닿도록 못 뚫으면 실패 경향이 있습니다.<br>" +
      "<b>순위 = 정석 부합도(0~100점):</b> ① 추세선 터치 횟수(선당 3회 이상 만점 — 2회는 정의상 최소일 뿐) " +
      "② 수렴 기간 거래량 감소(대칭 삼각형의 약 86%에서 관찰되는 교과서 신호) ③ 꼭짓점까지 60~78% 진행(돌파가 " +
      "몰리는 최적 구간) ④ 피벗이 추세선에 붙는 밀착도(ATR 0.5 이내 만점) ⑤ 유형 정합(대칭은 좌우 기울기 균형, " +
      "상승·하락은 수평선의 수평도) ⑥ 최근 5일 거래량 마름(돌파 직전의 침묵) ⑦ 유형별 실증 신뢰도(상승>대칭>하락)를 " +
      "가중 결합합니다." +
      "<span class='src'>기준 출처: Bulkowski (2005) · Edwards & Magee · Murphy, 「Technical Analysis of the Financial Markets」</span>",
    head_shoulders:
      "<b>헤드 앤 숄더란?</b> 상승 추세의 끝에서 나타나는 대표적 천장형 반전 패턴입니다. 가운데가 가장 높은 " +
      "세 개의 봉우리(어깨-머리-어깨)를 만들고, 두 되돌림 저점을 이은 <b>넥라인을 아래로 이탈하면 하락 반전 " +
      "신호</b>로 봅니다. 학술 연구(Lo·Mamaysky·Wang 2000)에서도 통계적 정보력이 확인된 패턴입니다. " +
      "여기서는 넥라인 접근 중이거나 이탈 직후(=지금 의미 있는) 형태만 보여줍니다.<br>" +
      "<b>자동 탈락:</b> 넥라인 이탈(완성) <b>시점</b>을 추적해 판정합니다 — ① 종가가 머리 위로 회복하면 " +
      "무효(busted, Bulkowski 2005) ② 완성 후 10봉이 지나면 신호 소진 (정보력은 완성 직후 집중 — " +
      "Lo·Mamaysky·Wang 2000 · 되돌림도 평균 ~10일 내 — Bulkowski) ③ 완성 후 종가가 넥라인 위로 " +
      "2% 넘게 회복하면 실패 돌파로 무효 (정상 되돌림은 넥라인 부근까지) ④ 이탈 방향으로 5% 넘게 " +
      "진행됐으면 진입 늦음(5% 룰). 완성됐다가 가격이 회복해도 목록에 되살아나지 않습니다.<br>" +
      "<b>순위 = 정석 부합도(0~100점):</b> ① 패턴 앞의 상승 추세(반전할 대상 — 왼어깨까지 30% 이상 상승 만점) " +
      "② 세 봉우리 거래량 감소(왼어깨>머리>오른어깨 — 고전에서 가장 강조되는 신호, 오른어깨로 늘면 0점) " +
      "③ 넥라인 이탈봉의 거래량 확대 ④ 어깨 가격 대칭(1.5% 이내 만점)과 시간 대칭 ⑤ 머리 돌출(ATR 1.5배 " +
      "이상 만점 — 밋밋하면 삼중천장과 구분 불가) ⑥ 넥라인 기울기(수평~완만한 하향이 실증상 더 큰 하락) " +
      "⑦ 이탈 후 미회복(throwback 없는 패턴이 더 멀리 감)을 가중 결합합니다." +
      "<span class='src'>기준 출처: Bulkowski (2005) 성과 통계 · Edwards & Magee · Lo·Mamaysky·Wang (2000, Journal of Finance)</span>",
    inv_head_shoulders:
      "<b>역헤드 앤 숄더란?</b> 헤드 앤 숄더를 뒤집은 바닥형 반전 패턴입니다. 하락 추세 끝에서 가운데가 가장 " +
      "깊은 세 개의 골(어깨-머리-어깨)을 만들고, <b>넥라인을 위로 돌파하면 상승 반전 신호</b>로 봅니다. " +
      "머리에서 거래량이 줄고 돌파에서 거래량이 늘면 신뢰도가 높아지는 것으로 알려져 있습니다.<br>" +
      "<b>자동 탈락:</b> 넥라인 돌파(완성) <b>시점</b>을 추적해 판정합니다 — ① 종가가 머리(최저점) 아래로 " +
      "내려가면 무효(busted) ② 완성 후 10봉 경과 시 신호 소진 ③ 완성 후 종가가 넥라인 아래로 2% 넘게 " +
      "되밀리면 실패 돌파로 무효 ④ 돌파 방향으로 5% 넘게 진행됐으면 진입 늦음(5% 룰).<br>" +
      "<b>순위 = 정석 부합도(0~100점):</b> 바닥형은 천장형과 달리 <b>돌파 거래량이 필수</b>입니다(Edwards & " +
      "Magee 의 천장/바닥 비대칭 — 바닥은 거래량 급증 없이 못 오른다). 그래서 ① 넥라인 돌파 거래량(베이스 " +
      "평균의 2배 만점)을 가장 크게 반영하고, ② 머리 탈출 랠리의 거래량 증가(하락 대비 1.5배 만점 — 수요 등장의 " +
      "신호) ③ 패턴 앞의 하락 추세(반전할 대상) ④ 머리 깊이(ATR 1.5배 이상 만점) ⑤ 어깨 가격·시간 대칭 " +
      "⑥ 넥라인 기울기(수평~완만한 상향 유리) ⑦ 돌파 후 미되밀림을 가중 결합합니다." +
      "<span class='src'>기준 출처: Edwards & Magee · Bulkowski (2005) 성과 통계 · Lo·Mamaysky·Wang (2000)</span>",
    cup_handle:
      "<b>컵 앤 핸들이란?</b> 고점에서 완만하게 하락했다가 둥근 바닥을 그리며 회복하는 '컵'과, 이전 고점 " +
      "부근에서의 얕은 되돌림 '핸들'로 이루어진 상승 지속 패턴입니다 (윌리엄 오닐이 대중화). " +
      "<b>핸들 상단(컵 테두리) 돌파를 매수 신호</b>로 보며, V자 반등이 아니라 둥근 바닥일수록, 핸들 조정이 " +
      "얕을수록 교과서적입니다. 여기서는 2차곡선 적합도로 '둥근 정도'를 수치화해 V자를 걸러냅니다.<br>" +
      "<b>자동 탈락:</b> 핸들 조정이 컵 깊이의 절반 또는 15% 를 넘으면 무효(오닐의 핸들 규칙 — 핸들은 " +
      "컵 상반부에 있어야 함), 테두리 대비 -15% 아래로 무너지면 패턴 실패, 테두리 +5% 를 넘어 이미 " +
      "상승했으면 추격 구간이라 제외합니다 (오닐: 매수는 피벗 +5% 이내에서만).<br>" +
      "<b>순위 = 정석 부합도(0~100점):</b> ① 컵 이전의 상승 추세(+30% 이상 만점 — 지속 패턴의 전제) " +
      "② 컵 깊이 12~33%(오닐의 이상 밴드 — 얕으면 털기 부족, 깊으면 실손상) ③ 둥근 U자 적합도와 바닥의 " +
      "중앙 위치 ④ 컵 기간 7~35주 ⑤ 핸들이 컵 상단 절반에서 완만히 하향(오닐의 최우선 판별 — 상향 쐐기 " +
      "핸들은 불량 베이스) ⑥ 핸들 깊이 5~15% ⑦ 핸들 거래량 마름(매도 소진) ⑧ 테두리 돌파 거래량(평균의 " +
      "1.4배 이상 만점, 돌파 전이면 채점 제외)을 가중 결합합니다." +
      "<span class='src'>기준 출처: William O'Neil, 「How to Make Money in Stocks」 · Bulkowski (2005)</span>",
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
    partyNote: document.getElementById("partyNote"),
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
    if (el.partyNote) el.partyNote.style.display = on ? "block" : "none";
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
  // 첫 공개 최소 로딩: 결과가 이미 계산돼 즉시 와도 몇 초간 스캔 애니메이션을
  // 보여줘 '진짜로 훑는다'는 신뢰를 준다 (한 화면 진입당 1회). 실제 스캔이
  // 그보다 오래 걸리면 추가 지연은 없다.
  let revealed = false;
  let firstReveal = true; // 첫 진입만 길게 — 이후 카드/시장 전환은 짧은 확인만
  let loadStartMs = 0;
  const nowMs = () => (window.performance && performance.now
    ? performance.now() : Date.now());
  function minRevealMs() {
    return firstReveal ? 3000 + Math.random() * 1800   // 첫 진입 3.0~4.8초
                       : 1200 + Math.random() * 800;   // 전환 1.2~2.0초
  }

  function activateCard(card) {
    if (card.dataset.pattern === pattern) return; // 같은 카드 재클릭 — 재스캔 불필요
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
    if (!btn || btn.dataset.market === market) return; // 같은 시장 재클릭 무시
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

  // 보이는 매칭 내용 기준 지문 — 스캔 진행 중 매칭이 바뀔 때만 재렌더한다
  function matchFp(body) {
    return JSON.stringify([
      body.totalMatches, !!body.refreshing, !!body.partial,
      (body.matches || []).map((m) => [m.symbol, m.score]),
    ]);
  }

  function statusText(body) {
    const shown = (body.matches || []).length;
    return `${body.scanned}개 종목 ${body.partial ? "스캔" : "스캔 완료"} · 매칭 ${body.totalMatches}개` +
      (body.totalMatches > shown ? ` (정석 부합도 상위 ${shown}개 표시)` : "") +
      (body.partial ? " · 남은 종목 계속 확인 중…"
        : body.refreshing ? " · 백그라운드에서 새 스캔 진행 중" : "");
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
    if (!isPoll) {
      // 사용자가 패턴/시장을 바꾼 경우에만 화면을 비운다 (폴링 중엔 유지)
      destroyCharts();
      el.matches.innerHTML = "";
      renderDesc();
      renderedWhileRefreshing = false;
      lastBody = null;
      lastFp = null;
      revealed = false;
      loadStartMs = nowMs();
      showParty(true); // 처음부터 스캔 애니메이션 (최소 로딩 신뢰 효과)
      el.status.innerHTML = '<span class="spinner"></span>패턴 스캔 중…';
    }
    try {
      const r = await fetch(`/api/patterns?pattern=${pattern}&market=${market}`,
                            { signal: pollSignal() });
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
      // 지문은 '보이는 매칭 내용' 기준 — 스캔 수만 늘고 매칭이 그대로면 차트를
      // 재생성하지 않아 깜빡임이 없다 (문구만 갱신).
      const fp = matchFp(body);
      const keepAlive = (body.refreshing || body.partial) ? 5000 : 30 * 60 * 1000;
      // 이 화면 진입 후 '첫 공개'는 최소 로딩 시간을 지킨다. 실제 스캔이 이미
      // 그만큼 걸렸으면 wait=0 이라 즉시, 결과가 순식간에 왔으면 남은 만큼 더
      // 애니메이션을 보여준 뒤 공개한다.
      if (!revealed) {
        revealed = true;
        const wait = Math.max(0, minRevealMs() - (nowMs() - loadStartMs));
        firstReveal = false;
        if (wait > 0) {
          showParty(true);
          pollTimer = setTimeout(() => {
            if (seq !== reqSeq) return; // 그새 시장/패턴을 바꿨으면 폐기
            // 이 콜백은 load 의 try/catch 밖이라, render 예외로 폴링 체인이
            // 죽지 않게 여기서 직접 감싸 다음 폴을 반드시 예약한다
            let nextMs = keepAlive;
            try {
              showParty(false);
              render(body);
              lastFp = fp;
              renderedWhileRefreshing = !!body.refreshing;
            } catch (e) {
              lastFp = null;   // 재렌더 강제
              nextMs = 4000;   // 곧 회복 폴
            }
            pollTimer = setTimeout(() => load(true), nextMs);
          }, wait);
          return;
        }
      }
      showParty(false);
      // '완성된 만료 결과'를 배경 재스캔 중 보여주는 경우만 재렌더 생략한다.
      // 부분(partial) 결과는 스캔이 돌며 점점 채워지므로 계속 갱신해야 한다.
      if (isPoll && renderedWhileRefreshing && body.refreshing && !body.partial) {
        el.status.textContent = statusText(body); // 스캔 수 등 문구만 갱신
        pollTimer = setTimeout(() => load(true), 5000);
        return;
      }
      if (isPoll && fp === lastFp) {
        el.status.textContent = statusText(body);
        pollTimer = setTimeout(() => load(true), keepAlive);
        return;
      }
      render(body);
      // 지문은 렌더가 '성공한 뒤'에만 확정한다 — 렌더 도중 예외가 나면
      // (예: 차트 라이브러리 로드 실패) 다음 폴이 같은 지문에 막혀
      // 고장난 화면이 keep-alive 에 갇히는 것을 방지
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
  // 테마 재렌더 신호는 theme.js 의 wt-themechange 하나로 통일 — 자동 모드의
  // OS 변경도 theme.js 가 중계하므로 OS(matchMedia)를 또 들으면 이중 재렌더가 된다.
  document.addEventListener("wt-themechange", onThemeChange);

  function render(body) {
    lastBody = body;
    destroyCharts();
    el.matches.innerHTML = "";
    el.status.textContent = statusText(body);
    // 진행 중(부분) 결과는 스크린리더에 알리지 않고, 최종 결과만 알린다
    if (!body.partial) announce(el.status.textContent);
    const matches = body.matches || [];
    if (!matches.length) {
      // 아직 스캔 중(부분)이면 '없음'을 성급히 단정하지 않는다
      el.matches.innerHTML = body.partial
        ? `<div class="empty">남은 종목을 확인하는 중입니다…<br>` +
          `<span style="font-size:12px">매칭되는 종목이 나오면 여기 채워집니다.</span></div>`
        : `<div class="empty">지금 이 패턴에 해당하는 종목이 없습니다.<br>` +
          `<span style="font-size:12px">패턴은 시장 상황에 따라 나타났다 사라집니다 — 다른 패턴/시장을 보거나 나중에 다시 확인해 보세요.</span></div>`;
      return;
    }
    matches.forEach((m) => {
      const card = document.createElement("div");
      card.className = "m-card";
      // 정석 부합도 0~100 — 점수대별 칩 색(80+ 에메랄드 / 60+ 기본 / 미만 중립)과
      // 카드 상단 미니 미터로 '얼마나 교과서적인가'를 한눈에 보여준다
      const sc = Math.max(0, Math.min(100, Math.round(Number(m.score) || 0)));
      const tier = sc >= 80 ? "t-high" : sc >= 60 ? "t-mid" : "t-low";
      card.innerHTML =
        `<div class="m-head">` +
        `<span><span class="m-name">${esc(m.name)}</span> ` +
        `<span class="m-code">${esc(m.symbol)}${m.market ? " · " + esc(m.market) : ""}</span></span>` +
        `<span><span class="m-score ${tier}" title="교과서 이상형과의 근접도 (0~100점)">정석 부합도 ${sc}점</span> ` +
        `<a class="m-link" href="/ma?symbol=${encodeURIComponent(m.symbol)}">이평선 분석 →</a></span>` +
        `</div>` +
        `<div class="m-meter" role="img" aria-label="정석 부합도 ${sc}점 (100점 만점)"><span style="width:${sc}%"></span></div>` +
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
