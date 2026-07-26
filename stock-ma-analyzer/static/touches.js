/* 오늘의 지지선 터치 프런트엔드 */
(function () {
  "use strict";

  // 한/영 분기 — i18n.js 가 head 에서 window.WT_T 를 정의한다 (없으면 한국어)
  const TR = window.WT_T || function (ko) { return ko; };

  // 라이트/다크 자동 대응 차트 테마 (사이트 공통 규약)
  const darkMq = window.matchMedia("(prefers-color-scheme: dark)");
  function chartTheme() {
    // 수동 전환(data-theme)이 있으면 그걸, 없으면 기기 설정을 따른다
    const forced = document.documentElement.dataset.theme;
    const dark = forced === "dark" || (forced !== "light" && darkMq.matches);
    return {
      text: dark ? "#9aa1a5" : "#62696d",
      grid: dark ? "rgba(255,255,255,.06)" : "rgba(9,11,12,.06)",
      border: dark ? "rgba(255,255,255,.11)" : "rgba(9,11,12,.10)",
      up: dark ? "#00d95a" : "#00a844",
      down: dark ? "#ff5f56" : "#e03131",
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
      el.partyCaption.textContent = TR("양봉이와 음봉이가 지지선을 짚어보는 중…", "Candle buddies are checking the support lines…");
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

  let market = "kr";
  let pollTimer = null;
  let reqSeq = 0;
  let renderedWhileRefreshing = false;
  let lastFp = null; // 직전 렌더의 지문 — 같은 결과 재렌더(깜빡임) 방지
  let pollFails = 0;
  let lastGen = null; // 마지막으로 렌더한 스냅숏 식별자 — 변화 없으면 서버가 본문 생략
  const charts = [];
  // 첫 공개 최소 로딩: 결과가 이미 계산돼 즉시 와도 몇 초간 스캔 애니메이션을
  // 보여줘 '진짜로 훑는다'는 신뢰를 준다 (한 화면 진입당 1회). 실제 스캔이
  // 그보다 오래 걸리면 추가 지연은 없다.
  let revealed = false;
  let firstReveal = true; // 첫 진입만 길게 — 이후 시장 전환은 짧은 확인만
  let loadStartMs = 0;
  const nowMs = () => (window.performance && performance.now
    ? performance.now() : Date.now());
  function minRevealMs() {
    return firstReveal ? 3000 + Math.random() * 1800   // 첫 진입 3.0~4.8초
                       : 1200 + Math.random() * 800;   // 전환 1.2~2.0초
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

  // 보이는 매칭 내용 기준 지문 — 스캔 진행 중 매칭이 바뀔 때만 재렌더한다
  function matchFp(body) {
    return JSON.stringify([
      body.totalMatches, !!body.refreshing, !!body.partial,
      (body.matches || []).map((m) => [m.symbol, m.maScore, m.distPct]),
    ]);
  }

  function statusText(body) {
    const shown = (body.matches || []).length;
    return TR(
      `${body.scanned}개 종목 ${body.partial ? "백테스트" : "백테스트 완료"} · 오늘 지지선 터치 ${body.totalMatches}개` +
        (body.totalMatches > shown ? ` (상위 ${shown}개 표시)` : "") +
        (body.partial ? " · 남은 종목 계속 확인 중…"
          : body.refreshing ? " · 백그라운드에서 새 스캔 진행 중" : ""),
      `${body.scanned} stocks ${body.partial ? "backtested so far" : "backtested"} · ${body.totalMatches} touching support today` +
        (body.totalMatches > shown ? ` (top ${shown} shown)` : "") +
        (body.partial ? " · still checking the rest…"
          : body.refreshing ? " · fresh scan running in background" : ""));
  }

  function updateProgress(body) {
    const label =
      TR(`${market === "kr" ? "국내" : "미국"} 종목 백테스트 중… ` +
           (body.total ? `${body.done}/${body.total} 종목` : "대상 선정 중"),
         `Backtesting ${market === "kr" ? "Korean" : "US"} stocks… ` +
           (body.total ? `${body.done}/${body.total} stocks` : "picking the universe"));
    const pct = body.total ? Math.round((body.done / body.total) * 100) : 0;
    let bar = el.status.querySelector(".bar > div");
    if (!bar) {
      el.status.innerHTML =
        `<span class="scan-label"></span><div class="bar"><div style="width:0%"></div></div>`;
      bar = el.status.querySelector(".bar > div");
      announce(TR("종목 스캔을 시작했습니다. 완료되면 알려드립니다.", "Scan started. We\u2019ll let you know when it finishes."));
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
      destroyCharts();
      el.matches.innerHTML = "";
      renderedWhileRefreshing = false;
      lastBody = null;
      lastFp = null;
      lastGen = null;
      revealed = false;
      loadStartMs = nowMs();
      showParty(true); // 처음부터 스캔 애니메이션 (최소 로딩 신뢰 효과)
      el.status.innerHTML = '<span class="spinner"></span>' + TR("지지선 터치 스캔 중…", "Scanning for support touches…");
    }
    try {
      const r = await fetch(`/api/touches?market=${market}` +
                            (lastGen != null ? `&since=${lastGen}` : ""),
                            { signal: pollSignal() });
      if (seq !== reqSeq) return;
      if (r.status === 401) {  // 세션 만료 등 — 로그인 페이지로
        location.href = "/login?next=%2Ftouches";
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      if (seq !== reqSeq) return;
      pollFails = 0;
      if (body.unchanged) {
        // 서버: 마지막 렌더 이후 변화 없음 — 본문 전송 생략 (유휴 트래픽·CPU 절감)
        pollTimer = setTimeout(() => load(true), 30 * 60 * 1000);
        return;
      }
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
        lastBody = null;
        lastFp = null;
        el.status.textContent = body.detail || TR("스캔 실패 — 잠시 후 다시 시도해 주세요.", "Scan failed — please try again in a moment.");
        announce(el.status.textContent);
        pollTimer = setTimeout(() => load(true), 15000);
        return;
      }
      lastGen = body.generatedAt;
      // 지문은 '보이는 매칭 내용' 기준 — 스캔 수만 늘고 매칭이 그대로면 재렌더 없음
      const fp = matchFp(body);
      const keepAlive = (body.refreshing || body.partial) ? 5000 : 30 * 60 * 1000;
      // 이 화면 진입 후 '첫 공개'는 최소 로딩 시간을 지킨다 (즉시 오는 고정
      // 결과라도 몇 초간 스캔 애니메이션). 실제 스캔이 더 오래 걸렸으면 wait=0.
      if (!revealed) {
        revealed = true;
        const wait = Math.max(0, minRevealMs() - (nowMs() - loadStartMs));
        firstReveal = false;
        if (wait > 0) {
          showParty(true);
          pollTimer = setTimeout(() => {
            if (seq !== reqSeq) return; // 그새 시장을 바꿨으면 폐기
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
      // 지문은 렌더가 '성공한 뒤'에만 확정한다 — 렌더 도중 예외가 나면
      // 고장난 화면이 keep-alive 에 갇히는 것을 방지
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
      // 테마 전환 재렌더가 "백그라운드 갱신 중"이라고 거짓 표시하지 않게 정리
      if (lastBody) lastBody.refreshing = false;
      renderedWhileRefreshing = false;
      lastFp = null; // 회복 폴이 실패 문구를 확실히 걷어내도록 재렌더 강제
      el.status.textContent = TR("스캔 실패: ", "Scan failed: ") + err.message;
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
        ? `<div class="empty">${TR("남은 종목을 확인하는 중입니다…", "Still checking the remaining stocks…")}<br>` +
          `<span style="font-size:12px">${TR("오늘 지지선에 닿은 종목이 나오면 여기 채워집니다.", "Stocks touching support today will appear here as they are found.")}</span></div>`
        : `<div class="empty">${TR("오늘 검증된 지지선에 닿아 있는 종목이 없습니다.", "No stock is touching a verified support line today.")}<br>` +
          `<span style="font-size:12px">${TR("터치는 매일 달라집니다 — 내일 다시 확인하거나 다른 시장을 살펴보세요.", "Touches change daily — check back tomorrow or try the other market.")}</span></div>`;
      return;
    }
    matches.forEach((m) => {
      const card = document.createElement("div");
      card.className = "m-card";
      const rate = (m.successRate * 100).toFixed(0);
      const dist = m.distPct > 0 ? `+${m.distPct}%` : `${m.distPct}%`;
      card.innerHTML =
        `<div class="m-head">` +
        `<span><span class="m-name">${esc(m.name)}</span> ` +
        `<span class="m-code">${esc(m.symbol)}${m.market ? " · " + esc(m.market) : ""}</span></span>` +
        `<span><span class="ma-chip">MA ${esc(m.period)}</span> ` +
        `<a class="m-link" href="/ma?symbol=${encodeURIComponent(m.symbol)}">${TR("이평선 분석 →", "MA analysis →")}</a></span>` +
        `</div>` +
        `<div class="m-meter" role="img" aria-label="${TR("3년 지지 성공률", "3-yr support hold rate")} ${esc(rate)}%"><span style="width:${Math.max(0, Math.min(100, Number(rate) || 0))}%"></span></div>` +
        TR(`<div class="m-summary">3년 지지 성공률 <b>${esc(rate)}%</b> · 지지 성공 ${esc(m.supportBounces)}회 (터치 ${esc(m.touches)}회) · ` +
             `오늘 종가는 선 대비 <b>${esc(dist)}</b> (선 ${esc(m.maValue)})</div>`,
           `<div class="m-summary">3-yr support hold rate <b>${esc(rate)}%</b> · held ${esc(m.supportBounces)}× (of ${esc(m.touches)} touches) · ` +
             `close vs line <b>${esc(dist)}</b> (line ${esc(m.maValue)})</div>`) +
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
        text: TR("터치", "Touch"),
      }]);
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

  load();
})();
