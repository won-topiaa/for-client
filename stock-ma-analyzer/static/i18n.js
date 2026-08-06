/* 한/영 전환 — localStorage("wt_lang") 기반.
   - 기본 한국어. EN 선택 시: ① 짧은 문구는 TEXT 사전(텍스트 노드 정확 일치)으로,
     ② 긴 설명 블록은 페이지별 HTML 사전(셀렉터→영문 본문)으로 치환.
   - 동적 문구는 각 페이지 JS 가 window.WT_T(ko, en) 로 직접 분기.
   - 전환은 저장 후 새로고침(가장 단순·안전). 사전에 없는 문구는 원문 유지라
     스크립트가 실패해도 화면이 깨지지 않는다. */
(function () {
  "use strict";

  var LANG = "ko";

  function readStored() {
    try { return localStorage.getItem("wt_lang"); } catch (e) { return null; }
  }
  // 저장 후 실제로 저장됐는지까지 확인 — 사생활 보호 모드처럼 쓰기가 막힌
  // 브라우저에서는 setItem 이 조용히 실패하거나 예외를 던진다.
  function store(v) {
    try {
      localStorage.setItem("wt_lang", v);
      return localStorage.getItem("wt_lang") === v;
    } catch (e) { return false; }
  }
  function stripLangParam() {
    if (!window.history || !history.replaceState) return;
    try {
      var u = new URL(location.href);
      u.searchParams.delete("lang");
      history.replaceState(null, "", u.pathname + u.search + u.hash);
    } catch (e) { /* 주소만 못 지웠을 뿐, 화면은 정상 */ }
  }

  try {
    // ?lang=en|ko 로 접속하면 그 언어를 저장하고 바로 적용 — SNS 공유 링크가
    // 외국인 방문자를 곧장 영어 화면으로 데려갈 수 있게 한다.
    var qs = new URLSearchParams(location.search).get("lang");
    if (qs === "en" || qs === "ko") {
      LANG = qs;
      // 저장에 성공했을 때만 주소에서 lang 을 지운다. 남겨두면 토글을 눌러
      // 저장값을 바꿔도 새로고침 때 URL 값이 다시 덮어써서 버튼이 영원히
      // 안 먹는다. 반대로 저장이 막힌 브라우저에서는 URL 이 유일한 기억
      // 수단이므로 그대로 둔다.
      if (store(qs)) stripLangParam();
    } else {
      LANG = readStored() === "en" ? "en" : "ko";
    }
  } catch (e) {}
  window.WT_LANG = LANG;
  window.WT_T = function (ko, en) { return LANG === "en" ? en : ko; };

  // ── ① 짧은 문구 사전 (텍스트 노드/속성 정확 일치) ──
  var TEXT = {
    // 내비게이션·공통
    "🏠 홈": "🏠 Home", "홈": "Home",
    "📈 이평선 분석": "📈 MA Analyzer", "이평선 분석": "MA Analyzer",
    "🔍 패턴 스크리너": "🔍 Pattern Screener", "패턴 스크리너": "Pattern Screener",
    "🚨 오늘의 터치": "🚨 Today's Touches", "오늘의 터치": "Today's Touches",
    "📐 내 이평선": "📐 My MA Line", "내 이평선": "My MA Line",
    "🏢 원토피아 소개": "🏢 About", "🏢 소개": "🏢 About",
    "🔒 개인정보처리방침": "🔒 Privacy", "개인정보처리방침": "Privacy Policy",
    "🔗 링크 모음": "🔗 Links", "링크 모음": "Links",
    "로그아웃": "Log out",
    "명 접속 중": " online",
    "지금 접속 중인 방문자 수": "Visitors online now",
    "🇰🇷 국내": "🇰🇷 Korea", "🇺🇸 미국": "🇺🇸 US",
    "데이터로 보는 기술적 분석": "Technical analysis, backed by data",
    "스캔하는 동안 시장 한입 지식을 보여드립니다…": "Bite-size market notes while we scan…",
    // 접근성 라벨 (title/aria-label)
    "라이트/다크 모드 전환": "Toggle light/dark theme",
    "주요 지수 시세": "Major index quotes",
    "종목 검색 결과": "Search suggestions",
    "사이트 링크": "Site links",
    "도구 바로가기": "Tools",
    "핵심 수치": "Key numbers",
    "이용 방법": "How to use",
    "이동평균선 매매법 소개": "About MA trading",
    "대표 종목 바로 분석": "Quick picks",
    "이동평균선 기간 (5~250일)": "MA period (5–250 days)",
    "주식 레이더 로고": "Stock Radar logo",
    "원토피아 로고": "Wontopia logo",
    "참고용 데이터 시각화입니다.": "For informational purposes only.",
    "본 사이트는 과거 데이터 통계이며 매수 추천·투자 권유가 아닙니다. 모든 투자 결정과 결과는 본인 책임입니다.":
      "This site shows historical statistics only — not investment advice. All investment decisions are your own responsibility.",
    "본 도구는 과거 데이터 통계이며 매수 추천·투자 권유가 아닙니다. 모든 투자 결정과 결과는 본인 책임입니다.":
      "This tool shows historical statistics only — not investment advice. All investment decisions are your own responsibility.",
    "본 도구는 과거 데이터 통계이며 투자 권유가 아닙니다. 미래의 지지/저항을 보장하지 않으며, 모든 투자 결정과 결과는 본인 책임입니다.":
      "This tool shows historical statistics only — not investment advice. Past support/resistance never guarantees the future; all investment decisions are your own responsibility.",
    "(4th ed.). McGraw-Hill. (초판 1988)": "(4th ed.). McGraw-Hill. (first published 1988)",

    // 페이지 제목·부제
    "주식 레이더": "Stock Radar",
    "차트 패턴 스크리너": "Chart Pattern Screener",
    "오늘의 지지선 터치": "Today's Support Touches",
    "내 이평선 스크리너": "My MA Line Screener",
    "이평선 레이더": "MA Radar",
    "교과서 패턴의 기하학적 정의로 전 종목을 스캔해, 지금 그 모양을 만드는 종목을 찾습니다":
      "Scans every stock against textbook pattern geometry and finds the ones forming it right now",
    "백테스트로 검증된 이평선에 오늘 가격이 닿아 있는 종목을 찾아드립니다":
      "Stocks touching a backtest-verified support MA today",
    "원하는 이평선을 입력하면 지지받는 종목과 저항받는 종목을 나눠 드립니다":
      "Enter any MA period — get stocks holding it as support vs. blocked at resistance",

    // 패턴 카드
    "🚀 와인스타인 초기 2단계": "🚀 Weinstein Early Stage 2",
    "바닥 돌파 직후 — 이론상 최적 매수 구간": "Fresh base breakout — the textbook entry zone",
    "📐 삼각수렴": "📐 Triangle",
    "고점·저점이 좁아지며 수렴 (대칭/상승/하락)": "Converging highs & lows (sym/asc/desc)",
    "⛰ 헤드 앤 숄더": "⛰ Head & Shoulders",
    "천장형 반전 — 어깨·머리·어깨 + 넥라인": "Topping reversal — shoulders, head, neckline",
    "🏔 역헤드 앤 숄더": "🏔 Inverse H&S",
    "바닥형 반전 — 뒤집힌 어깨·머리·어깨": "Bottoming reversal — inverted H&S",
    "☕ 컵 앤 핸들": "☕ Cup & Handle",
    "둥근 바닥(컵) + 얕은 조정(핸들)": "Rounded base (cup) + shallow pullback (handle)",

    // 이평선 분석 페이지 컨트롤
    "일봉 · 주봉 · 월봉의 주요 지지/저항 이동평균선 백테스트":
      "Backtests the key support/resistance moving averages — daily · weekly · monthly",
    "종목 검색 (이름 또는 코드)": "Search stock (name or code)",
    "예: 삼성전자, 005930": "e.g. Samsung, 005930, AAPL",
    "일봉 기간(년)": "Daily lookback (y)",
    "주봉 기간(년)": "Weekly (y)",
    "월봉 기간(년)": "Monthly (y)",
    "분석": "Analyze",
    "🇰🇷 국내 대표": "🇰🇷 Korea picks",
    "🇺🇸 미국 대표": "🇺🇸 US picks",
    "삼성전자": "Samsung Elec.", "SK하이닉스": "SK hynix", "현대차": "Hyundai Motor",
    "네이버": "NAVER", "LG에너지솔루션": "LG Energy Solution", "알파벳(구글)": "Alphabet (Google)",
    "애플": "Apple", "엔비디아": "NVIDIA", "테슬라": "Tesla", "마이크로소프트": "Microsoft",
    "기간 0 = 상장 후 전체 기간 · 추천 기본값: 일봉 3년, 주봉 7년, 월봉 전체 (최근 흐름에 자동 가중)":
      "0 = full listed history · defaults: daily 3y, weekly 7y, monthly full (recent action auto-weighted)",
    "일봉": "Daily", "주봉": "Weekly", "월봉": "Monthly",
    "이벤트 마커:": "Event markers:",
    "지지 성공 (반등)": "Support held (bounce)",
    "저항 성공 (하락)": "Resistance held (drop)",
    "지지 이탈 (아래로 뚫림)": "Support break (down)",
    "저항 돌파 (위로 뚫음)": "Resistance break (up)",
    "전체 후보 이평선 성적표": "All candidate MAs — scorecard",
    "★ = 추천 · 최근 사건에 가중치를 준 성공률 기준": "★ = recommended · success rate weighted toward recent events",
    "터치": "Touches", "지지성공": "Sup. held", "저항성공": "Res. held",
    "돌파(실패)": "Breaks", "미확정": "Undecided", "성공률*": "Success*",
    "점수": "Score", "최근 터치": "Last touch",
    "* 성공률은 최근 사건에 더 큰 가중치를 준 가중 성공률입니다. 점수 = 성공률 신뢰하한 × log(1+가중 성공 횟수) — \"자주 그리고 믿을 만하게\" 지지/저항이 된 순서.":
      "* Success rate is recency-weighted. Score = Wilson lower bound of the success rate × log(1 + weighted holds) — lines that held \"often and reliably\" rank first.",

    // 맞춤 이평선 컨트롤
    "이평선": "MA", "일선": "-day", "조회": "Go",
    "20일": "20d", "50일": "50d", "60일": "60d", "120일": "120d", "200일": "200d",

    // 홈 스탯
    "스캔 유니버스 종목 (KR·US)": "stocks scanned (KR·US)",
    "종목당 백테스트 기간": "years backtested per stock",
    "기준이 근거한 학술·고전 문헌": "academic & classic sources",
    "종목당 분석 시세 데이터": "daily bars analyzed per stock",
    "년+": "y+", "편": "refs", "봉": "bars",

    // 로그인 페이지
    "이메일": "Email", "비밀번호": "Password",
    "로그인": "Log in", "가입하기": "Create account",
    "8자 이상": "8+ characters",
    "비밀번호는 8자 이상으로 정해주세요.": "Password must be at least 8 characters.",
    "아직 계정이 없으신가요?": "Don't have an account yet?",
    "← 홈으로 돌아가기": "← Back to home",

    // 소개 페이지
    "원토피아 소개": "About Wontopia",
    "주식 레이더를 만드는 곳": "The workshop behind Stock Radar",
    "주식 레이더 홈": "Stock Radar home",

    // 패턴 스크리너 참고 문헌 (인용은 이미 영어 — 용도 설명만 번역)
    "📚 참고 문헌 — 스크리너의 매칭·탈락 기준이 근거한 자료":
      "📚 References — sources behind the matching & drop rules",
    "— 기하학적 패턴 탐지 방법론 · 패턴 정보력은 완성 직후에 집중 (헤드앤숄더 탈락 기준)":
      "— Geometric pattern-detection methodology · pattern information concentrates right after completion (H&S drop rule)",
    "— 기술적 분석 효과는 초대형주에서 가장 약함 (유니버스에서 초대형주 제외)":
      "— Technical-analysis effects are weakest in mega-caps (excluded from our universe)",
    "— 거래비용·데이터 스누핑 경고 (유동성 상위 종목만 스캔)":
      "— Warns about trading costs & data snooping (we scan only high-liquidity names)",
    "— 모멘텀(상대강도) 효과 (와인스타인 RS 가점의 학술 근거)":
      "— Momentum (relative strength) effect (academic basis for the Weinstein RS bonus)",
    "— 패턴별 실패율·busted 패턴 정의·5% 룰·삼각형 돌파는 꼭짓점 거리의 평균 73~75% 지점 (헤드앤숄더·삼각수렴 탈락 기준)":
      "— Per-pattern failure rates · busted patterns · the 5% rule · triangle breakouts average 73–75% of the way to the apex (H&S / triangle drop rules)",
    "— 컵앤핸들 정의 · 핸들은 컵 상반부 · 매수는 피벗 +5% 이내 (컵앤핸들 매칭·탈락 기준)":
      "— Cup-&-handle definition · handle stays in the cup's upper half · buy within +5% of the pivot (C&H rules)",
    "— 4단계 주가 사이클 · 30주선 매매 규칙 · 돌파 거래량 기준 (초기 2단계 매칭·탈락 기준)":
      "— 4-stage price cycle · 30-week-MA rules · breakout volume requirement (early Stage 2 rules)",
  };

  // ── ② 페이지별 긴 설명 블록 (셀렉터 → 영문 innerHTML) ──
  var SRC_NOTE = '<span class="src">Sources: the MA Radar backtest engine (Wilson lower-bound scoring) · Weinstein (1988) · Brock, Lakonishok &amp; LeBaron (1992)</span>';
  var BADGE = '<span style="font-size:11px;font-weight:600;color:var(--accent);border:1px solid var(--hairline);border-radius:999px;padding:2px 9px;vertical-align:3px;background:var(--panel2);">Members · free</span>';
  var HTML = {
    "/": {
      ".hero h2": 'Confirm with <span class="em">data</span>, not gut feeling',
      ".hero p": "Every rule is backtested and grounded in published research — with sources shown.",
      '.tool-card[href="/ma"]': '<span class="icon">📈</span>' +
        "<h3>MA Radar</h3>" +
        '<p class="desc">Search any stock and we backtest <b>which moving averages actually acted as support/resistance</b> on daily, weekly and monthly bars — ranked, with past events drawn on the chart.</p>' +
        "<ul><li>KR &amp; US stock search + one-click picks</li>" +
        "<li>2–3 recommended MAs per timeframe, with success rates</li>" +
        "<li>Past support/resistance/break events as chart markers</li></ul>" +
        '<span class="go">Analyze a stock →</span>',
      '.tool-card[href="/patterns"]': '<span class="icon">🔍</span>' +
        "<h3>Chart Pattern Screener</h3>" +
        '<p class="desc">Weinstein early Stage 2 · triangles · head &amp; shoulders · cup &amp; handle — <b>every stock auto-scanned against textbook pattern geometry</b> to find the ones forming a pattern right now.</p>' +
        "<ul><li>KR (top 300 by trading value) · US (S&amp;P 500) universes</li>" +
        "<li>Research-based matching rules + auto drop-out on invalidation</li>" +
        "<li>Evidence shown as numbers · sorted by textbook-fit score</li></ul>" +
        '<span class="go">See the scan →</span>',
      '.tool-card[href="/touches"]': '<span class="icon">🚨</span>' +
        "<h3>Today's Support Touches " + BADGE + "</h3>" +
        '<p class="desc">The two tools flipped around — a daily screener for <b>stocks touching a backtest-verified support MA today</b>.</p>' +
        "<ul><li>Each stock's reliable lines verified by a 3-year backtest</li>" +
        "<li>Only lows inside the band: max(0.5×ATR, 0.15%)</li>" +
        "<li>Sorted by line confidence · a fresh list every day</li></ul>" +
        '<span class="go">See today’s touches →</span>',
      '.tool-card[href="/lines"]': '<span class="icon">📐</span>' +
        "<h3>My MA Line Screener " + BADGE + "</h3>" +
        '<p class="desc">Type any MA period (say, the 50-day) and get <b>stocks holding it as support vs. stocks blocked at it as resistance</b>, in two lists.</p>' +
        "<ul><li>Any period 5–250 days (20·50·60·120·200 presets)</li>" +
        "<li>All 5 support/resistance criteria shown on screen</li>" +
        "<li>Sorted by 3-year backtest success (Wilson lower bound)</li></ul>" +
        '<span class="go">Screen by my line →</span>',
      ".howto": '<h3 class="howto-title">New here? <span class="em">Here’s how to use it</span></h3>' +
        '<ol class="steps">' +
        '<li class="step"><span class="n">1</span><div><div class="t">Search a stock in <a href="/ma">MA Analyzer</a></div>' +
        '<p class="d">The 20/50-day MA everyone watches may not work for <b>your</b> stock — we backtest which lines actually held, with success rates.</p></div></li>' +
        '<li class="step"><span class="n">2</span><div><div class="t">No stock in mind? Open the <a href="/patterns">Pattern Screener</a></div>' +
        '<p class="d">Scans 770+ KR &amp; US stocks and ranks the ones forming textbook chart patterns by <b>conformity score</b>.</p></div></li>' +
        '<li class="step"><span class="n">3</span><div><div class="t">Each morning, check <a href="/touches">Touches</a> · <a href="/lines">My MA Line</a></div>' +
        '<p class="d">Fresh daily lists: stocks touching a <b>verified support line today</b>, and stocks holding/blocked at <b>the MA you choose</b> (free, 10-second signup).</p></div></li>' +
        "</ol>" +
        '<p class="howto-note">⚠️ All tools show historical statistics — use them for confirmation, not as buy signals. All investment decisions are your own responsibility.</p>',
      ".basis": "<b>Grounded methodology</b> — every rule is based on Lo·Mamaysky·Wang (2000, <i>Journal of Finance</i>), Han·Yang·Zhou (2013), Park·Irwin (2007), Bulkowski (2005), O'Neil and Weinstein (1988). Full references are at the bottom of the <a href=\"/patterns\">Pattern Screener</a>. Built by <a href=\"/about\"><b>Wontopia</b></a>.",
      ".ma-method": '<details class="fold"><summary><h3 class="howto-title" style="margin:0">What is MA trading? <span class="em">Why it suits busy people</span></h3></summary>' +
        '<div style="margin-top:14px"><div class="mm-grid"><div class="mm-what">' +
        "<p>A <b>moving average (MA)</b> is the average closing price of the last N days drawn as a line. MA trading is <b>trend following</b>: hold while price stays <b>above a rising line</b>, exit when it <b>closes decisively below</b>. The rule is drawn right on the chart — no complex analysis needed.</p>" +
        '<p class="mm-caution">⚠️ Not a silver bullet — sideways markets produce frequent whipsaw signals, and past performance never guarantees the future. That’s why every screen here shows its evidence and sources.</p>' +
        '</div><ul class="mm-why">' +
        "<li><b>Once a day is enough</b> — daily/weekly bars mean no intraday watching. Weinstein ran it on a weekly check.</li>" +
        "<li><b>Less emotion</b> — “above the line: hold, confirmed break: exit” leaves little room for impulse.</li>" +
        "<li><b>Academically studied</b> — Brock·Lakonishok·LeBaron (1992, <i>J. Finance</i>) documented MA-rule predictive power; Park·Irwin (2007) documented its limits. Both sides are known.</li>" +
        '</ul></div><p class="mm-bridge">One question remains — <b>“which line?”</b> That’s exactly what <a href="/ma">MA Radar</a> answers per stock, and <a href="/touches">Today’s Touches</a> turns into a daily list.</p></div></details>',
    },
    "/patterns": {
      ".note": "Universe — 🇰🇷 KR: top 300 by trading value (mega-caps excluded — research shows technical effects are weakest there) · 🇺🇸 US: S&amp;P 500 ex-mega-caps · latest listings at scan time.<br>Detection is rule-based and may include incomplete/failed shapes. Stocks that <b>invalidate</b> a pattern (per each pattern's documented rules) drop out at the next refresh.",
      ".party-note": "We fetch and backtest 3 years of data per stock, so a cold start can take a few seconds up to 2–3 minutes. Results fill in as they are found.",
    },
    "/touches": {
      ".method": '<p class="method-lead"><b>How it works:</b> a daily screener showing stocks whose price <b>touched a backtest-verified support line today</b>, ranked by confidence — top 12.</p>' +
        '<details class="method-more"><summary>Criteria &amp; cautions</summary><div class="method-body">' +
        "<p>Every stock in the universe is backtested over <b>3 years of daily bars</b> to find moving averages that repeatedly acted as support. Only <b>verified lines</b> qualify: 3+ past support bounces and a recency-weighted success rate of 60%+ (5-day MA excluded as unreliable). We then show stocks whose <b>low touched that line's band today</b> (band = max(0.5×ATR, 0.15% of price)) without a confirmed close below. Ranked by the line's confidence score (Wilson lower bound × log(1+weighted bounces)); the success rate on each card is that same recency-weighted 3-year figure.</p>" +
        '<p class="method-caution"><b>Caution:</b> a touch of a historically strong line is an alert, not a bounce guarantee — a break below can accelerate the downside.</p>' +
        SRC_NOTE + "</div></details>",
      ".note": "Universe — 🇰🇷 KR: top 300 by trading value (top-30 mega-caps excluded) · 🇺🇸 US: S&amp;P 500 ex-mega-caps · touches judged on the last completed trading day.",
      ".party-note": "We fetch and backtest 3 years of data per stock, so a cold start can take a few seconds up to 2–3 minutes. Results fill in as they are found.",
    },
    "/lines": {
      ".method": '<p class="method-lead"><b>The criteria?</b> Only stocks that meet <b>every</b> backtest-verified quant rule, split into two lists — holding as support vs. blocked at resistance, top 6 each.</p>' +
        '<details class="method-more"><summary>Criteria &amp; cautions</summary><div class="method-body">' +
        "<p><b>Holding as support</b> = ① 70%+ of the last 20 closes above the line (trend anchored above) ② the low touched the line's band within the last 5 bars (band = max(0.5×ATR14, 0.15%)) ③ no confirmed break — today's close above line−band and no engine-confirmed breakdown in the last 5 bars ④ 10-bar slope ≥ −0.2% (declining-MA support excluded — Weinstein) ⑤ 3-year backtest: 2+ decided support episodes with a weighted hold rate ≥ 50%.</p>" +
        '<p><b>Blocked at resistance</b> is the exact mirror. Ranked by confidence (Wilson lower bound × log(1+weighted holds)), top 6 each.</p>' +
        '<p class="method-caution"><b>Caution:</b> “the line is being tested” is an observation, not a direction call — breaks can accelerate moves either way.</p>' +
        SRC_NOTE + "</div></details>",
      ".note": "Universe — 🇰🇷 KR: top 300 by trading value (mega-caps excluded) · 🇺🇸 US: S&amp;P 500 ex-mega-caps · judged on the last completed trading day.",
      ".party-note": "We fetch and backtest 3 years of data per stock, so a cold start can take a few seconds up to 2–3 minutes. Results fill in as they are found.",
    },
    "/ma": {
      ".intro": "<p>We backtest which moving averages actually acted as support/resistance for this stock, and rank them.</p>" +
        '<p class="sub2">Daily, weekly and monthly — 2–3 most reliable lines each, with touch/bounce/break events drawn on the chart.</p>',
    },
    "/login": {
      ".lead": "<b>Today's Support Touches</b> is members-only.<br>Log in with your email, or sign up — it takes 10 seconds.",
      ".consent span": 'I agree to the <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>. We only collect your email and an encrypted password.',
    },
    "/about": {
      ".hero h2": "Wontopia",
      ".hero p": "A workshop for pulling ideas out freely and building whatever comes of them.",
      "#ab-name h3": "Where the name comes from",
      "#ab-name .card": "<p>Wontopia joins <b>Won</b> — the last syllable of the maker's name — to the <b>-topia</b> of <b>utopia</b>.</p>" +
        "<p>There's no grand meaning behind it. It's simply meant to be a place where ideas can come out freely and get built. " +
        "When something makes us curious, we check it against data; when the result looks useful, we turn it into a web tool anyone can use, and publish it.</p>",
      "#ab-works h3": "Things we've built",
      '#ab-works a[href="/"] .t': "📊 Stock Radar",
      '#ab-works a[href="/"] .d': "MA backtests · chart-pattern screener · today's support touches · my-MA-line screener. " +
        "Every decision rule carries its source — academic research and classic texts.",
      "#ab-works a[target] .t": "📉 Earnings Volatility",
      "#ab-works a[target] .d": "How much US stocks actually moved on quarterly earnings days, from 5 years of data — " +
        "plus an estimate of the next report's move based on that history.",
      "#ab-how h3": "How we work",
      "#ab-how .hows": '<div class="how"><span class="n">01</span>' +
        '<span><span class="b">We show our sources.</span> ' +
        '<span class="d">We try not to ship a feature that can’t answer “where did this rule come from?”</span></span></div>' +
        '<div class="how"><span class="n">02</span>' +
        '<span><span class="b">We ship small, then improve.</span> ' +
        '<span class="d">Using it and fixing it beats planning it perfectly.</span></span></div>' +
        '<div class="how"><span class="n">03</span>' +
        '<span><span class="b">We keep it fun.</span> ' +
        '<span class="d">That’s why dancing candle bots live on the loading screen.</span></span></div>',
      "#ab-contact h3": "Work with us · Contact",
      "#ab-contact .contact p:first-of-type": "Data tools, investing content, web services — if there's something you'd like to build together, " +
        "get in touch. Proposals, feedback and bug reports are all welcome.",
      "#ab-contact .mail": "✉️ Send a collaboration inquiry",
      "#ab-contact .tip": "A short intro plus what you have in mind gets you a faster reply.",
      "footer p": "© Wontopia · The tools on this site are historical statistics, not investment advice.",
    },
    "/links": {
      ".hero h1": "Wontopia",
      ".tagline": "We check ideas against data — and when they hold up, we ship them as web tools",
      ".sec-works": "Selected Works",
      // 작업물 카드는 서버가 DB 에서 렌더링(관리자가 /links/admin 에서 직접
      // 추가/수정)하므로 여기 하드코딩하지 않는다 — 카드 각 요소의
      // data-en 속성을 translateDataAttrs() 가 범용으로 치환한다.
      "footer .disc": "Each tool shows historical statistics — not investment advice.",
      "footer .copy": '© Wontopia · <a href="/privacy">Privacy Policy</a>',
    },
    "/privacy": {
      "h1": "Privacy Policy",
      ".updated": "Wontopia treats your personal data with care and collects only the minimum required." +
        '<br><span style="font-size:12.5px">This English text is a convenience translation. ' +
        'The <a href="/privacy?lang=ko">Korean version</a> is the legally binding one.</span>',
      ".card": "<h2>1. What we collect</h2>" +
        "<p>For signup and login we collect only the following.</p>" +
        "<table><tr><th>Item</th><th>Purpose</th></tr>" +
        "<tr><td>Email address</td><td>Identifies your account and serves as your login ID</td></tr>" +
        "<tr><td>Password</td><td>Stored only as an irreversible <b>one-way hash (PBKDF2)</b> — the plaintext is never stored</td></tr></table>" +
        '<p class="muted">We collect no other personal data — no name, phone number or national ID. We take no payment information.</p>' +
        "<h2>2. Why we collect it</h2>" +
        "<ul><li>To identify members and keep you logged in</li>" +
        "<li>To provide members-only features such as “Today's Support Touches”</li></ul>" +
        '<p class="muted">We do not use it for marketing, advertising or profiling.</p>' +
        "<h2>3. How long we keep it</h2>" +
        "<p>Until you close your account or ask us to delete it — on request we erase it without delay. " +
        "Where the law requires separate retention, we follow that period.</p>" +
        "<h2>4. Sharing with third parties</h2>" +
        "<p>We <b>never provide or sell your personal data to third parties.</b></p>" +
        "<h2>5. Processors and overseas storage</h2>" +
        "<p>We use cloud infrastructure to run the service, and member data is stored encrypted on servers of database " +
        "providers (e.g. Neon, Render). Those servers <b>may be located outside Korea.</b> " +
        "What is stored is limited to the items in section 1 (email, password hash).</p>" +
        "<h2>6. Your rights</h2>" +
        "<p>You may request <b>access, correction, deletion or suspension of processing</b> of your personal data at any time. " +
        "Contact us at the address below and we will act promptly.</p>" +
        "<h2>7. Security measures</h2>" +
        "<ul><li>One-way password hashing (PBKDF2-HMAC-SHA256 + salt) — no plaintext stored</li>" +
        "<li>Encryption in transit (HTTPS)</li>" +
        "<li>Session tokens stored server-side as hashes only; cookies are httpOnly</li>" +
        "<li>Least-privilege access</li></ul>" +
        "<h2>8. Contact</h2>" +
        "<p>Privacy questions, access and deletion requests: " +
        '<a href="mailto:wontopiaaa@gmail.com?subject=%5BPrivacy%5D%20Inquiry">wontopiaaa@gmail.com</a></p>',
      ".note": "This policy applies from the service's public launch, and any change will be announced on this page. " +
        "If member features or the data we collect change, the policy is updated with them.",
    },
  };

  // ── ②-b 페이지별 '속성' 사전 (셀렉터 → {속성: 값}) ──
  // innerHTML 만 바꾸면 링크의 href 같은 속성은 한국어로 남는다.
  var ATTRS = {
    "/links": {
      '.social a[href^="mailto:"]': {
        href: "mailto:wontopiaaa@gmail.com?subject=%5BWontopia%5D%20Inquiry",
      },
    },
    "/about": {
      ".contact .mail": {
        href: "mailto:wontopiaaa@gmail.com?subject=%5BWontopia%5D%20Collaboration%20inquiry",
      },
    },
  };

  // data-mfold 제목(모바일 접기 버튼) 번역
  var MFOLD = {
    "📖 처음이신가요? 이용법": "📖 New here? How to use",
    "📚 근거 문헌 안내": "📚 Sources",
    "ℹ️ 패턴 설명·판정 기준": "ℹ️ Pattern & criteria",
    "📄 스캔 대상 안내": "📄 Universe & notes",
    "📚 참고 문헌": "📚 References",
    "ℹ️ 어떻게 찾나요? (판정 기준)": "ℹ️ How it works",
    "ℹ️ 판정 기준 (지지/저항)": "ℹ️ Criteria (support/resistance)",
  };

  function translateTextNodes(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var raw = node.nodeValue;
      if (!raw) continue;
      var key = raw.trim();
      if (key && Object.prototype.hasOwnProperty.call(TEXT, key)) {
        node.nodeValue = raw.replace(key, TEXT[key]);
      }
    }
  }

  function translateAttrs() {
    ["placeholder", "title", "aria-label", "value"].forEach(function (attr) {
      document.querySelectorAll("[" + attr + "]").forEach(function (el) {
        var v = el.getAttribute(attr);
        if (v && Object.prototype.hasOwnProperty.call(TEXT, v.trim())) {
          el.setAttribute(attr, TEXT[v.trim()]);
        }
      });
    });
    document.querySelectorAll("[data-mfold]").forEach(function (el) {
      var v = el.getAttribute("data-mfold");
      if (MFOLD[v]) el.setAttribute("data-mfold", MFOLD[v]);
    });
  }

  // 서버가 DB 에서 렌더링하는 콘텐츠(예: /links 작업물 카드)는 페이지별
  // 사전에 미리 써 둘 수 없다 — 관리자가 나중에 새로 추가하는 항목까지는
  // 코드가 알 도리가 없기 때문. 대신 요소 자신에게 영문을 data-en 속성으로
  // 실어 보내면(서버 렌더링 시점에 함께) 여기서 범용으로 치환한다. 값이
  // 비어 있으면(관리자가 영문을 안 채움) 원문(한국어) 그대로 둔다.
  function translateDataAttrs() {
    document.querySelectorAll("[data-en]").forEach(function (el) {
      var en = el.getAttribute("data-en");
      if (en) el.textContent = en;
    });
  }

  function applyEnglish() {
    document.documentElement.lang = "en";
    var page = HTML[location.pathname];
    if (page) {
      Object.keys(page).forEach(function (sel) {
        var el = document.querySelector(sel);
        if (el) el.innerHTML = page[sel];
      });
    }
    var pageAttrs = ATTRS[location.pathname];
    if (pageAttrs) {
      Object.keys(pageAttrs).forEach(function (sel) {
        var el = document.querySelector(sel);
        if (!el) return;
        var spec = pageAttrs[sel];
        Object.keys(spec).forEach(function (a) { el.setAttribute(a, spec[a]); });
      });
    }
    translateAttrs();
    translateDataAttrs();
    translateTextNodes(document.body);
    document.title = document.title
      .replace("주식 레이더 — 데이터로 보는 기술적 분석", "Stock Radar — technical analysis, backed by data")
      .replace("주식 레이더", "Stock Radar")
      .replace("차트 패턴 스크리너", "Chart Pattern Screener")
      .replace("오늘의 지지선 터치", "Today's Support Touches")
      .replace("내 이평선 스크리너", "My MA Line Screener")
      .replace("이평선 레이더 — 주요 지지/저항 이동평균선 분석기", "MA Radar — support/resistance MA analyzer")
      .replace("원토피아 소개", "About Wontopia")
      .replace("원토피아", "Wontopia")   // 포트폴리오 페이지 제목
      .replace("링크 모음", "Links")
      .replace("개인정보처리방침", "Privacy Policy")
      .replace("로그인", "Log in");
  }

  function wireToggle() {
    var btn = document.getElementById("langToggle");
    if (!btn) return;
    btn.textContent = LANG === "en" ? "한" : "EN";
    btn.setAttribute("aria-label",
      LANG === "en" ? "한국어로 보기" : "View in English");
    btn.addEventListener("click", function () {
      var next = LANG === "en" ? "ko" : "en";
      if (store(next)) {
        location.reload();
        return;
      }
      // 저장이 막힌 브라우저: 새로고침해도 같은 상태라 아무 일도 안 일어난다.
      // 주소에 lang 을 실어 이동하면 최소한 지금 보는 페이지는 전환된다.
      try {
        var u = new URL(location.href);
        u.searchParams.set("lang", next);
        location.href = u.pathname + u.search + u.hash;
      } catch (e) { location.reload(); }
    });
  }

  function boot() {
    try {
      if (LANG === "en") applyEnglish();
    } catch (e) { /* 번역 실패 시 원문(한국어) 유지 — 화면은 항상 동작 */ }
    wireToggle();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
