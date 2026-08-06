/* 로딩 화면 한입 지식 카드 (사이트 공통)
   스캔을 기다리는 동안 전일 시장 요약 · 패턴 사전 · 패턴 이론 · 투자 명언 ·
   매크로 상식을 한 장씩 돌려 보여준다.
   규칙: 짧으면 한 줄, 길어도 두 줄 — 본문은 85자를 넘기지 않는다 (테스트로 강제). */
(function () {
  "use strict";

  const T = (tag, text) => ({ tag, text });

  const TIPS = [
    // ---- 패턴 사전: 이 사이트가 찾는 다섯 가지 패턴 ----
    T("패턴 사전", "헤드 앤 숄더: 가운데가 가장 높은 세 봉우리 뒤 넥라인을 깨면 하락 반전으로 보는 대표적인 천장형 패턴입니다."),
    T("패턴 사전", "역헤드 앤 숄더: 가운데가 가장 깊은 세 개의 골을 만든 뒤 넥라인을 위로 뚫으면 상승 반전 신호로 봅니다."),
    T("패턴 사전", "삼각수렴: 고점과 저점이 서로 좁혀지며 에너지가 응축되는 구간 — 통계상 돌파는 평균적으로 꼭짓점까지 73~75% 지점에서 나옵니다."),
    T("패턴 사전", "컵 앤 핸들: 둥근 바닥(컵) 뒤 얕은 조정(핸들)이 붙는 상승 지속 패턴 — 핸들 깊이는 컵의 절반을 넘지 않아야 교과서적입니다."),
    T("패턴 사전", "와인스타인 2단계: 긴 바닥 다지기를 끝내고 30주선 위로 첫 돌파가 나온 직후 — 와인스타인이 이상적 진입 구간으로 꼽은 시기입니다."),
    // ---- 패턴 이론: 왜 이렇게 스캔하는가 ----
    T("패턴 이론", "차트 패턴이 추가 정보를 담을 수 있다는 학계 연구도 있습니다 — Lo·Mamaysky·Wang(2000, Journal of Finance)."),
    T("패턴 이론", "돌파 뒤 절반 이상은 넥라인으로 한 번 되돌아옵니다(스로우백) — 돌파가 진짜인지 확인할 두 번째 기회입니다."),
    T("패턴 이론", "거래량 없는 돌파는 의심하세요 — 이 스크리너는 평소 거래량의 1.3배 이상(교과서는 2배)을 요구합니다."),
    T("패턴 이론", "기술적 분석은 정보 반영이 느린 중소형주에서 효과가 더 크다는 연구가 많습니다 — 이 스크리너가 초대형주를 빼는 이유입니다."),
    T("패턴 이론", "지지선은 횟수 못지않게 최근성이 중요합니다 — 이 사이트 점수는 최근의 큰 반등에 더 높은 가중치를 둡니다."),
    // ---- 투자 명언 ----
    T("명언", "“시장은 당신이 버틸 수 있는 기간보다 더 오래 비이성적일 수 있다.” — 케인스의 말로 전해지는 월가 격언"),
    T("명언", "“시장은 단기적으로는 투표 기계지만, 장기적으로는 저울이다.” — 벤저민 그레이엄"),
    T("명언", "“남들이 탐욕스러울 때 두려워하고, 남들이 두려워할 때 탐욕스러워라.” — 워런 버핏"),
    T("명언", "“주가 조정을 예측하려다 잃은 돈이 조정 그 자체로 잃은 돈보다 훨씬 많다.” — 피터 린치"),
    T("명언", "“강세장은 비관 속에서 태어나 회의 속에서 자라며, 낙관 속에서 무르익고 행복감 속에서 죽는다.” — 존 템플턴"),
    T("명언", "“큰돈은 사고파는 데가 아니라 기다리는 데 있다.” — 찰리 멍거"),
    T("명언", "“경제와 주가는 주인과 산책 나온 개와 같다 — 개는 앞서거니 뒤서거니 해도 결국 주인 곁으로 온다.” — 앙드레 코스톨라니"),
    // ---- 매크로 상식 ----
    T("매크로", "금리가 오르면 미래 이익의 할인율이 커져 성장주가 먼저 흔들리고, 금리가 내리면 그 반대가 되기 쉽습니다."),
    T("매크로", "원/달러 환율 상승은 수출주에 우호적이지만, 외국인 자금 이탈과 겹치면 지수 전체에는 부담이 됩니다."),
    T("매크로", "장단기 금리차(10년−2년) 역전은 고전적인 침체 경고 신호입니다 — 다만 실제 침체까지의 시차는 1~2년으로 깁니다."),
    T("매크로", "VIX(공포지수) 급등은 단기 바닥 신호로 자주 언급되지만, 추세 전환까지 보장하지는 않습니다."),
    T("매크로", "미국 CPI·고용보고서 발표일에는 변동성이 커집니다 — 이런 날의 돌파에는 가짜가 섞이기 쉽습니다."),
    T("매크로", "달러 강세기에는 신흥국 증시에서 자금이 빠지기 쉽습니다 — 코스피가 미국보다 크게 흔들리는 배경 중 하나입니다."),
  ];

  // EN 모드용 카드 — 같은 다섯 갈래를 영어로 (i18n.js 가 head 에서 먼저 실행돼
  // window.WT_LANG 이 항상 정의돼 있다. 없으면 한국어 덱으로 동작)
  const TIPS_EN = [
    T("Patterns", "Head & shoulders: three peaks with the middle one highest — a neckline break below is the classic topping-reversal signal."),
    T("Patterns", "Inverse head & shoulders: three troughs, middle one deepest — an upward neckline break signals a bottoming reversal."),
    T("Patterns", "Triangles: highs and lows converge as energy compresses — breakouts statistically happen ~73–75% of the way to the apex."),
    T("Patterns", "Cup & handle: a rounded base plus a shallow pullback — the handle should stay in the cup's upper half to be textbook."),
    T("Patterns", "Weinstein Stage 2: the first breakout above a long base and a rising 30-week MA — his ideal entry window."),
    T("Theory", "Academic work suggests chart patterns can carry real information — Lo, Mamaysky & Wang (2000, Journal of Finance)."),
    T("Theory", "More than half of breakouts throw back to the neckline once — a second chance to check whether the break is real."),
    T("Theory", "Distrust breakouts without volume — this screener requires 1.3× average volume (textbooks ask for 2×)."),
    T("Theory", "Technical effects tend to be stronger in mid/small caps than mega-caps — that's why we exclude the biggest names."),
    T("Theory", "Recency matters as much as frequency for support lines — our score weights recent big bounces more."),
    T("Quotes", "“The market can stay irrational longer than you can stay solvent.” — Wall Street adage, attributed to Keynes"),
    T("Quotes", "“In the short run the market is a voting machine; in the long run it is a weighing machine.” — Benjamin Graham"),
    T("Quotes", "“Be fearful when others are greedy, and greedy when others are fearful.” — Warren Buffett"),
    T("Quotes", "“Far more money has been lost preparing for corrections than in the corrections themselves.” — Peter Lynch"),
    T("Quotes", "“The big money is not in the buying and selling, but in the waiting.” — Charlie Munger"),
    T("Macro", "Rising rates discount future profits harder, so growth stocks wobble first — falling rates tend to do the reverse."),
    T("Macro", "A 10y–2y yield-curve inversion is the classic recession warning — but the lag to an actual recession runs 1–2 years."),
    T("Macro", "VIX spikes are often cited as short-term bottom signals, but they never guarantee a trend reversal."),
    T("Macro", "CPI and jobs-report days bring extra volatility — breakouts on those days are more often fake."),
    T("Macro", "A strong dollar tends to pull money out of emerging markets — one reason KOSPI can swing harder than the US."),
  ];

  // 섞은 덱에서 한 장씩 뽑고, 덱이 떨어지면 다시 섞는다
  const ALL = (window.WT_LANG === "en") ? TIPS_EN : TIPS;
  let deck = [];
  let lastText = "";
  const priority = []; // 도착하는 즉시 다음 순서로 보여줄 카드 (전일 시장 요약)

  function reshuffle() {
    deck = ALL.slice();
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    // 새 덱의 첫 장(= 배열 끝)이 직전 카드와 같으면 자리를 바꿔 연속 중복을 막는다
    if (deck.length > 1 && deck[deck.length - 1].text === lastText) {
      [deck[deck.length - 1], deck[0]] = [deck[0], deck[deck.length - 1]];
    }
  }

  // 시장 등락 요약: 헤더 티커와 같은 /api/indices 를 재사용해 카드 한 장을 만든다
  // (장중엔 실시간 등락, 장 마감 후엔 종가 기준 — 데이터가 신선하므로 라벨을
  // '종가'로 못 박지 않는다 · 실패하면 조용히 생략)
  fetch("/api/indices")
    .then((r) => (r.ok ? r.json() : null))
    .then((body) => {
      const items = (body && body.indices) || [];
      if (!items.length) return;
      const NAME_EN = { "코스피": "KOSPI", "코스닥": "KOSDAQ", "나스닥": "NASDAQ" };
      const parts = items.map((it) => {
        const pct = Number(it.changePct);
        const nm = (window.WT_LANG === "en" && NAME_EN[it.name]) ? NAME_EN[it.name] : it.name;
        return `${nm} ${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
      });
      // 휴장일이 어긋나면(예: 국내 휴장 중 미국 개장) 지수마다 마지막 거래일이
      // 다를 수 있다 — 전부 같은 날일 때만 날짜를 못 박고, 아니면 두루뭉술하게
      const dates = new Set(items.map((it) => it.date));
      const label = window.WT_LANG === "en"
        ? (dates.size === 1 ? `as of ${items[0].date}` : "latest index levels")
        : (dates.size === 1 ? `${items[0].date} 기준` : "최근 지수");
      const tip = T(window.WT_LANG === "en" ? "Markets" : "시장 등락", `${label} — ${parts.join(" · ")}`);
      priority.push(tip); // 지금 로딩 중이면 다음 로테이션에서 바로 보여준다
      ALL.push(tip);      // 이후 덱에도 합류
    })
    .catch(() => {});

  window.LoadingTips = {
    next() {
      if (priority.length) {
        const t = priority.shift();
        lastText = t.text;
        return t;
      }
      if (!deck.length) reshuffle();
      const t = deck.pop();
      lastText = t.text;
      return t;
    },
  };
})();
