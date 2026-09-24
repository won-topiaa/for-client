/**
 * 홍보 영상 — v1.3.0 (차트 패턴 · 다크 모드 · 토스 디자인)
 *
 * 1080×1920 세로 · 30fps · 약 27초 · H.264 MP4 + 배경음악(AAC 192k).
 * 음악은 make_promo_music.py 가 합성한 오리지널 곡이다(외부 음원 없음 — 저작권 걱정 없음).
 * 소리를 끄고 봐도 이해되게 말은 자막으로만 한다 — 피드 영상 대부분은 무음으로 재생된다.
 *
 * 사용 (저장소 루트에서):
 *   node apps-in-toss/scripts/make_promo_video.mjs --fetch        # 운영 서버에서 오늘 데이터 → promo_data.json
 *        --pick cup_handle=1                                      #   패턴별로 몇 번째 매치를 쓸지 (기본 0)
 *   node apps-in-toss/scripts/make_promo_video.mjs                # 영상 → apps-in-toss/store/promo-v1.3.0.mp4
 *   node apps-in-toss/scripts/make_promo_video.mjs --frames 100,400   # 그 프레임만 PNG 로 (검수용)
 *
 * ffmpeg: 환경변수 FFMPEG_PATH > PATH 의 ffmpeg.
 * 음악: scripts/store/promo_music.wav 가 없으면 make_promo_music.py 를 먼저 돌린다 (numpy·scipy 필요).
 *   영상 타임라인(T · TAPS)을 바꾸면 음악 쪽 효과음 시각도 같이 옮겨야 박자가 맞는다.
 *   (컨테이너에 없으면 `pip download imageio-ffmpeg` 휠 안의 정적 바이너리를 쓰면 된다)
 *
 * 무엇이 어디서 오나 — make_store_screenshots.mjs 와 같은 원칙(출처 단일화):
 *   - 색: src/theme.ts 의 LIGHT · DARK 팔레트 (transpile 해서 실제 값 사용)
 *   - 문구: src/env.ts (DISCLAIMER · BRAND_NAME · API_BASE_URL)
 *   - 숫자 포맷: src/format.ts 의 함수를 그대로 실행
 *   - 수치·차트: 운영 서버의 공개 API 응답 (앱이 부르는 것과 같은 엔드포인트)
 *   - 화면 구성: v1.3.0(3332eb3) 의 radar · screener · patterns · TabBar 를 따라 그렸다
 *
 * 1.3.0 에 없는 기능(아침 브리핑·관심종목 알림·맞춤 이평선)은 넣지 않는다 —
 * 영상을 보고 들어온 사람이 그 화면을 찾지 못하면 광고가 거짓말이 된다.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const DATA_FILE = path.join(HERE, 'store', 'promo_data.json');
const OUT_FILE = path.join(APP, 'store', 'promo-v1.3.0.mp4');

const W = 1080;
const H = 1920;
const FPS = 30;
const DURATION = 27.5;

/* ---------- 앱 소스에서 토큰·문구·포맷 함수 로드 ---------- */

function loadTS(rel, shims = {}) {
  const src = fs.readFileSync(path.join(APP, rel), 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const req = (name) => {
    if (shims[name]) return shims[name];
    throw new Error(`shim 없음: ${name} (${rel})`);
  };
  new Function('exports', 'require', 'module', js)(mod.exports, req, mod);
  return mod.exports;
}

const theme = loadTS('src/theme.ts', {
  react: {},
  'react-native': { useColorScheme: () => 'light' },
  '@apps-in-toss/framework': { Storage: {} },
});
const env = loadTS('src/env.ts');
const fmt = loadTS('src/format.ts');
const LIGHT = theme.LIGHT;
const DARK = theme.DARK;

/* ---------- --fetch: 운영 서버에서 오늘 데이터를 받아 필요한 만큼만 남긴다 ---------- */

function getJSON(route) {
  // node fetch 는 프록시 환경변수를 안 따른다 — curl 로 받는다
  const out = execFileSync('curl', ['-sf', '--max-time', '150', `${env.API_BASE_URL}${route}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function fetchData(pick) {
  const RADAR = { symbol: '005930', name: '삼성전자', market: 'KOSPI' };
  const analyze = getJSON(`/api/analyze?symbol=${RADAR.symbol}`);
  const wk = analyze.timeframes.week;
  const candles = wk.candles.slice(-104); // 주봉 2년 — 봉이 굵어 화면에서 읽힌다
  const from = candles[0].time;
  const recs = wk.recommended.slice(0, 3).map((r) => ({
    period: r.period,
    supportTests: r.supportTests,
    supportBounces: r.supportBounces,
    supportRate: r.supportRate,
    qualified: r.qualified,
    ma: r.ma.filter((p) => p.time >= from),
    events: r.events.filter((e) => e.time >= from && e.outcome !== 'undecided'),
  }));

  const touches = getJSON('/api/touches?market=kr');
  if (touches.status !== 'done') throw new Error(`지지선 스캔이 아직 안 끝났다: ${touches.status}`);
  const matches = touches.matches.slice(0, 3).map((m) => ({
    name: m.name, symbol: m.symbol, market: m.market, period: m.period,
    supportRate: m.supportRate, supportTests: m.supportTests, supportBounces: m.supportBounces,
    distPct: m.distPct, maValue: m.maValue, close: m.close,
    candles: m.candles.slice(-40), maLine: m.maLine.slice(-46),
  }));

  const patterns = {};
  for (const key of ['stage2', 'triangle', 'cup_handle']) {
    const body = getJSON(`/api/patterns?pattern=${key}&market=kr`);
    // 서버 순서(점수)의 첫 번째가 화면에서 늘 모양이 잘 드러나는 건 아니다 — 영상에서는
    // 한눈에 '아, 그 모양'이 보이는 종목을 고른다. 고른 번호는 --pick 으로 남긴다.
    const i = pick[key] ?? 0;
    const m = (body.matches ?? [])[i];
    if (!m) throw new Error(`${key}: ${i}번째 매치가 없다 (오늘 ${(body.matches ?? []).length}건)`);
    patterns[key] = {
      name: m.name, symbol: m.symbol, market: m.market, summary: m.summary,
      candles: m.candles, overlays: m.overlays,
    };
  }

  const data = {
    generatedAt: new Date().toISOString(),
    source: env.API_BASE_URL,
    radar: { ...RADAR, timeframe: 'week', candles, recs },
    touches: matches,
    patterns,
    pick,
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(data));
  console.log(`OK: ${DATA_FILE} (${(fs.statSync(DATA_FILE).size / 1024).toFixed(0)} KB)`);
}

/* ---------- 한글 폰트 (make_store_screenshots.mjs 와 같은 캐시를 쓴다) ---------- */

function ensureFonts() {
  const dir = path.join(HERE, 'store', 'fonts');
  const cssPath = path.join(dir, 'fonts.css');
  if (fs.existsSync(cssPath)) return fs.readFileSync(cssPath, 'utf8');
  fs.mkdirSync(dir, { recursive: true });
  const cssUrl =
    'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&display=block';
  let css = execFileSync('curl', ['-sf', '-A', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120', cssUrl], {
    encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
  });
  const urls = [...css.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]);
  if (!urls.length) throw new Error('폰트 URL 을 찾지 못함');
  const listFile = path.join(dir, 'urls.txt');
  const nameOf = (u, i) => `f${i}${path.extname(new URL(u).pathname) || '.bin'}`;
  fs.writeFileSync(listFile, urls.map((u, i) => `url = "${u}"\noutput = "${nameOf(u, i)}"`).join('\n'));
  execFileSync('curl', ['-sf', '--parallel', '--parallel-max', '8', '-K', listFile], { cwd: dir });
  urls.forEach((u, i) => {
    css = css.replaceAll(u, `file://${path.join(dir, nameOf(u, i))}`);
  });
  fs.writeFileSync(cssPath, css);
  return css;
}

/* ---------- 화면 조각 (v1.3.0 의 컴포넌트를 HTML 로) ---------- */

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 폰 화면 논리 크기(pt) — 앱이 그려지는 좌표계. 확대는 CSS zoom 으로 한다
// (transform: scale 은 캔버스·글자를 비트맵째 늘려 흐려진다).
const LW = 375;
const LH = 780;
const Z = 1.72;
const BEZEL = 16;
const PHONE_W = Math.round(LW * Z + BEZEL * 2);
const PHONE_H = Math.round(LH * Z + BEZEL * 2);
const PHONE_TOP = 452;
const TAB_H = 58;

const PATTERN_INFO = {
  stage2: { label: '초기 상승추세', emoji: '📈', plain: '바닥에서 오래 눌려 있다가, 이제 막 위로 방향을 튼 모양이에요.' },
  triangle: { label: '삼각수렴', emoji: '📐', plain: '고점은 낮아지고 저점은 높아지며 변동폭이 점점 좁아지는 모양이에요.' },
  cup_handle: { label: '컵앤핸들', emoji: '☕', plain: 'U자로 완만히 회복한 뒤, 살짝 눌러 쉬어가는 모양이에요.' },
};
const PATTERN_ORDER = ['stage2', 'triangle', 'cup_handle'];

function screenCss(P, scope) {
  return `
  ${scope} { background:${P.bg}; color:${P.text}; }
  ${scope} .card { background:${P.card}; border-radius:16px; }
  ${scope} .faint { color:${P.faint}; }
  ${scope} .sub { color:${P.sub}; }
  ${scope} .status, ${scope} .nav { background:${P.bg}; }
  ${scope} .seg { background:${P.sunken}; }
  ${scope} .seg .on { background:${P.raised}; color:${P.text}; font-weight:700;
       ${P.dark ? '' : 'box-shadow:0 1px 4px rgba(0,0,0,.06);'} }
  ${scope} .seg span { color:${P.sub}; }
  ${scope} .badge { background:${P.primaryBg}; color:${P.primary}; }
  ${scope} .chip { background:${P.sunken}; color:${P.sub}; }
  ${scope} .chip.on { background:${P.primaryBg}; color:${P.primary}; font-weight:700; }
  ${scope} .meter { background:${P.sunken}; }
  ${scope} .meter i { background:${P.primary}; }
  ${scope} .tb { background:${P.card}; border-top:1px solid ${P.border}; }
  ${scope} .tlink { color:${P.primary}; }
  `;
}

function tabBar(P, active, id) {
  const tabs = [
    ['홈', `<div class="ic"><i style="width:0;height:0;border-left:11px solid transparent;border-right:11px solid transparent;border-bottom:9px solid currentColor"></i><i style="width:15px;height:10px;border-radius:0 0 2px 2px;background:currentColor"></i></div>`],
    ['이평선', `<div class="ic" style="flex-direction:row;align-items:flex-end;gap:3px"><i style="width:4px;height:9px;border-radius:2px;background:currentColor"></i><i style="width:4px;height:14px;border-radius:2px;background:currentColor"></i><i style="width:4px;height:19px;border-radius:2px;background:currentColor"></i></div>`],
    ['지지선', `<div class="ic" style="justify-content:flex-end"><i style="width:9px;height:9px;border-radius:5px;background:currentColor;margin-bottom:3px"></i><i style="width:22px;height:3px;border-radius:2px;background:currentColor"></i></div>`],
    ['패턴', `<div class="ic" style="position:relative"><i style="position:absolute;left:1px;top:3px;width:20px;height:2.5px;border-radius:2px;background:currentColor;transform:rotate(13deg)"></i><i style="position:absolute;left:1px;bottom:3px;width:20px;height:2.5px;border-radius:2px;background:currentColor;transform:rotate(-13deg)"></i></div>`],
    ['관심', `<div class="ic"><span style="font-size:19px;line-height:21px">★</span></div>`],
  ];
  return `<div class="tb" id="${id}">${tabs
    .map(([label, icon], i) => `<div class="tab" data-i="${i}" style="color:${i === active ? P.text : P.faint}">
        ${icon}<b style="font-weight:${i === active ? 700 : 500}">${label}</b></div>`)
    .join('')}</div>`;
}

function chrome(P) {
  return `<div class="status"><b>9:41</b><span>▮▮▮ ◠ ▭</span></div>
    <div class="nav"><span class="navtitle">이평선 레이더</span></div>`;
}

function pageRadar(P, D) {
  const r = D.radar;
  const recCard = (rec, i) => `
    <div class="card rec" data-i="${i}">
      <div class="rt"><i class="dot" style="background:${P.ma[i % P.ma.length]}"></i>MA ${rec.period}</div>
      <div class="rs sub">지지 시험 ${rec.supportTests}회 중 ${rec.supportBounces}회 성공 (${esc(fmt.fmtRate(rec.supportRate))})</div>
      <div class="rh faint">누르면 이 선만 보기</div>
    </div>`;
  return `
  <div class="pg" id="pgRadar"><div class="pad">
    <div class="card namecard">
      <div><div class="nm">${esc(r.name)}</div><div class="faint sy">${esc(r.symbol)} · ${esc(r.market)}</div></div>
      <div class="star" style="color:${P.muted}">☆</div>
    </div>
    <div class="seg"><span>일봉</span><span class="on">주봉</span><span>월봉</span></div>
    <div class="grid">
      <div class="card rec all" data-i="-1" style="background:${P.primaryBg}">
        <div class="rt">${r.recs.map((_, i) => `<i class="dot" style="background:${P.ma[i % P.ma.length]};margin-right:1px"></i>`).join('')}<span style="margin-left:3px">동시 보기</span></div>
        <div class="rs sub">추천 이평선 전체 표시</div>
        <div class="rh faint">지금 보는 중</div>
      </div>
      ${r.recs.map(recCard).join('')}
    </div>
    <div class="card chartcard">
      <canvas id="cvRadar" data-w="${LW - 40 - 28}" data-h="196"></canvas>
      <div class="legend faint" id="legRadar">
        <span><b style="color:${P.events.support}">▲</b> 지지 성공</span>
        <span><b style="color:${P.events.resistance}">▼</b> 저항 성공</span>
        <span><b style="color:${P.events.breakDown}">●</b> 뚫림</span>
      </div>
    </div>
  </div></div>`;
}

function pageScreener(P, D) {
  const card = (m, i) => {
    const pct = Math.max(0, Math.min(100, Math.round(m.supportRate * 100)));
    return `
    <div class="card mcard">
      <div class="mh"><div>
        <div class="mn">${esc(m.name)} <span class="badge">MA ${m.period}</span></div>
        <div class="faint sy">${esc(m.symbol)}${m.market ? ' · ' + esc(m.market) : ''}</div>
      </div><div class="star" style="color:${P.muted}">☆</div></div>
      <div class="stats">
        <div><div class="faint sl">현재가</div><div class="sv">${esc(fmt.fmtPrice(m.close))}</div></div>
        <div><div class="faint sl">MA ${m.period} 선</div><div class="sv">${esc(fmt.fmtPrice(m.maValue))}</div></div>
        <div><div class="faint sl">선 대비</div><div class="sv" style="color:${theme.signColor(m.distPct, P)}">${esc(fmt.fmtDistPct(m.distPct))}</div></div>
      </div>
      <div class="mt sub">3년 지지 시험 ${m.supportTests}회 중 <b style="color:${P.text}">${m.supportBounces}회 성공</b> · 지지 성공률 <b style="color:${P.text}">${esc(fmt.fmtRate(m.supportRate))}</b></div>
      <div class="meter"><i id="mt${i}" data-pct="${pct}"></i></div>
      <canvas id="cvM${i}" data-w="${LW - 40 - 40}" data-h="132"></canvas>
      <div class="tlink">이평선 분석 →</div>
    </div>`;
  };
  return `
  <div class="pg" id="pgScreener"><div class="pad" id="scrList">
    <div class="ph"><div class="pht">오늘의 지지선</div><div class="phs sub">검증된 지지 이평선에 오늘 저가가 닿은 종목만</div></div>
    <div class="seg"><span class="on">국내</span><span>미국</span></div>
    ${D.touches.slice(0, 2).map(card).join('')}
  </div></div>`;
}

function patternBlock(P, D, key, suffix) {
  const info = PATTERN_INFO[key];
  const m = D.patterns[key];
  return `
  <div class="pblock" data-key="${key}">
    <div class="card explain">
      <div class="ex1"><span class="ichip" style="background:${theme.accentBg(P, 'violet')}">${info.emoji}</span><b>${esc(info.label)}</b></div>
      <div class="ex2 sub">${esc(info.plain)}</div>
    </div>
    <div class="card pcard">
      <div class="mh"><div>
        <div class="mn">${esc(m.name)}</div>
        <div class="faint sy">${esc(m.symbol)}${m.market ? ' · ' + esc(m.market) : ''}</div>
      </div><div class="star" style="color:${P.muted}">☆</div></div>
      <div class="ps sub">${esc(m.summary)}</div>
      <canvas id="cvP_${key}${suffix}" data-w="${LW - 40 - 40}" data-h="165"></canvas>
      <div class="plegend">${m.overlays
        .map((ov, i) => `<span><i style="background:${P.ma[i % P.ma.length]}"></i>${esc(ov.name)}</span>`)
        .join('')}</div>
    </div>
  </div>`;
}

function pagePatterns(P, D, suffix) {
  return `
  <div class="pg" id="pgPatterns${suffix}"><div class="pad">
    <div class="ph"><div class="pht">차트 패턴</div><div class="phs sub">지금 이 모양을 만들고 있는 종목을 찾아드려요</div></div>
    <div class="chips">${PATTERN_ORDER.map((k) => `<span class="chip" data-key="${k}">${esc(PATTERN_INFO[k].label)}</span>`).join('')}</div>
    <div class="pstack">${PATTERN_ORDER.map((k) => patternBlock(P, D, k, suffix)).join('')}</div>
  </div></div>`;
}

/* ---------- 문서 ---------- */

function buildHtml(fontCss, D) {
  // 앱 아이콘 — 이 저장소의 static/icon.png 는 2026-08-30 에 멈춘 서버 사본이라 옛 초록
  // 아이콘이 남아 있다(docs/REPOS.md). 앱이 실제로 쓰는 건 granite.config.ts 의 brand.icon
  // (운영 서버가 서빙하는 흰 바탕 · 남색 캔들 · 주황 이평선)이고, 그 원본을 여기 둔다.
  const iconB64 = fs.readFileSync(path.join(HERE, 'store', 'app_icon.png')).toString('base64');
  const disclaimer = env.DISCLAIMER.split('. ')[0].replace(/\.?$/, '.');
  const P = LIGHT;
  const DK = DARK;

  const css = `
  ${fontCss}
  * { box-sizing:border-box; margin:0; padding:0; }
  html, body { width:${W}px; height:${H}px; overflow:hidden; background:${P.bg}; }
  body { font-family:'Noto Sans KR', sans-serif; -webkit-font-smoothing:antialiased; word-break:keep-all; }
  #stage { position:relative; width:${W}px; height:${H}px; overflow:hidden; }
  #bg { position:absolute; inset:0; background:${P.bg}; }

  .cap { position:absolute; left:84px; right:84px; top:128px; opacity:0; }
  .eyebrow { display:flex; align-items:center; gap:14px; font-size:34px; font-weight:700; color:${P.primary}; letter-spacing:-0.01em; }
  .new { font-size:26px; font-weight:900; color:#fff; background:${P.primaryFill}; border-radius:10px; padding:5px 14px 6px; letter-spacing:.04em; }
  .head { margin-top:20px; font-size:66px; font-weight:900; line-height:1.27; letter-spacing:-0.035em; color:var(--capText, ${P.text}); }

  #phone { position:absolute; left:${(W - PHONE_W) / 2}px; top:${PHONE_TOP}px; width:${PHONE_W}px; height:${PHONE_H}px;
           border-radius:96px; background:#0E0F12; padding:${BEZEL}px; border:3px solid #2C2F36;
           box-shadow: 0 40px 90px rgba(25,31,40,.20), 0 8px 24px rgba(25,31,40,.12); }
  #screen { position:relative; width:100%; height:100%; border-radius:${96 - BEZEL}px; overflow:hidden; }
  .layer { position:absolute; left:0; top:0; width:${LW}px; height:${LH}px; zoom:${Z}; overflow:hidden; }
  #dark { clip-path:circle(0px at 330px 70px); }

  .status { height:44px; display:flex; justify-content:space-between; align-items:center; padding:0 26px 0 30px; font-size:15px; }
  .status span { font-size:10px; letter-spacing:2px; opacity:.85; }
  .nav { height:44px; display:flex; align-items:center; justify-content:center; }
  .navtitle { font-size:16px; font-weight:700; }
  .pages { position:absolute; left:0; right:0; top:88px; bottom:${TAB_H}px; overflow:hidden; }
  .pg { position:absolute; inset:0; overflow:hidden; }
  .pad { padding:6px 20px 20px; display:flex; flex-direction:column; gap:12px; }

  .card { padding:16px; }
  .namecard { display:flex; justify-content:space-between; align-items:center; padding:16px 20px; }
  .nm { font-size:20px; font-weight:700; letter-spacing:-0.3px; }
  .sy { font-size:13px; margin-top:3px; }
  .star { font-size:22px; }
  .seg { display:flex; gap:4px; padding:4px; border-radius:12px; }
  .seg span { flex:1; text-align:center; padding:8px 0; border-radius:9px; font-size:14px; font-weight:500; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .rec { padding:12px 14px; display:flex; flex-direction:column; gap:3px; }
  .rt { display:flex; align-items:center; font-size:15px; font-weight:700; gap:5px; }
  .dot { display:inline-block; width:7px; height:7px; border-radius:4px; }
  .rs { font-size:12px; line-height:17px; }
  .rh { font-size:11.5px; }
  .chartcard { padding:14px; display:flex; flex-direction:column; gap:8px; }
  .legend { display:flex; gap:12px; font-size:12px; }
  .legend b { font-size:12px; }

  .ph { padding-top:6px; padding-bottom:2px; }
  .pht { font-size:24px; font-weight:700; letter-spacing:-0.4px; }
  .phs { font-size:15px; margin-top:6px; line-height:22px; }
  .mcard, .pcard { padding:20px; display:flex; flex-direction:column; gap:12px; }
  .mh { display:flex; justify-content:space-between; align-items:center; }
  .mn { font-size:17px; font-weight:700; display:flex; align-items:center; gap:6px; }
  .badge { font-size:11.5px; font-weight:700; border-radius:8px; padding:3px 7px; }
  .stats { display:flex; gap:8px; }
  .stats > div { flex:1; }
  .sl { font-size:12px; }
  .sv { font-size:15px; font-weight:700; margin-top:2px; }
  .mt { font-size:13.5px; line-height:21px; }
  .meter { height:6px; border-radius:3px; overflow:hidden; margin-top:-4px; }
  .meter i { display:block; height:6px; width:0; }
  .tlink { font-size:14px; font-weight:600; }

  .chips { display:flex; gap:6px; }
  .chip { padding:9px 14px; border-radius:999px; font-size:14px; font-weight:500; }
  .pstack { position:relative; height:520px; }
  .pblock { position:absolute; left:0; right:0; top:0; display:flex; flex-direction:column; gap:12px; opacity:0; }
  .explain { padding:18px 20px; display:flex; flex-direction:column; gap:10px; }
  .ex1 { display:flex; align-items:center; gap:12px; font-size:17px; }
  .ichip { width:36px; height:36px; border-radius:18px; display:inline-flex; align-items:center; justify-content:center; font-size:17px; }
  .ex2 { font-size:14.5px; line-height:23px; }
  .ps { font-size:13.5px; line-height:21px; }
  .plegend { display:flex; gap:12px; flex-wrap:wrap; font-size:12px; color:inherit; }
  .plegend span { display:inline-flex; align-items:center; gap:5px; }
  .plegend i { display:inline-block; width:12px; height:3px; border-radius:2px; }

  .tb { position:absolute; left:0; right:0; bottom:0; height:${TAB_H}px; display:flex; }
  .tab { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; }
  .tab b { font-size:11px; }
  .ic { width:22px; height:20px; display:flex; flex-direction:column; align-items:center; justify-content:center; }
  .ic i { display:block; }

  #touch { position:absolute; width:46px; height:46px; margin:-23px 0 0 -23px; border-radius:50%;
           background:rgba(25,31,40,.22); opacity:0; pointer-events:none; }

  #disc { position:absolute; left:0; right:0; top:${PHONE_TOP + PHONE_H + 22}px; text-align:center;
          font-size:25px; color:var(--discText, ${P.faint}); opacity:0; }

  .blue { position:absolute; inset:0; background:linear-gradient(165deg, #4593F7 0%, #3182F6 42%, #1B64DA 100%); color:#fff; }
  #hook .l1 { position:absolute; left:84px; right:84px; top:560px; font-size:112px; font-weight:900; letter-spacing:-0.04em; }
  #hook .strike { position:absolute; left:0; top:54%; height:10px; border-radius:5px; background:#fff; width:0; }
  #hook .l2 { position:absolute; left:84px; right:84px; top:800px; font-size:92px; font-weight:900; line-height:1.24; letter-spacing:-0.04em; }
  #hook .l2 em { font-style:normal; background:linear-gradient(transparent 62%, rgba(255,255,255,.28) 62%); }

  #end .icon { position:absolute; left:${(W - 260) / 2}px; top:520px; width:260px; height:260px; border-radius:60px;
               box-shadow:0 24px 60px rgba(0,0,0,.28); }
  #end .t { position:absolute; left:0; right:0; top:840px; text-align:center; font-size:108px; font-weight:900; letter-spacing:-0.04em; }
  #end .s { position:absolute; left:0; right:0; top:1000px; text-align:center; font-size:38px; font-weight:500; opacity:.92; }
  #end .cta { position:absolute; left:50%; top:1150px; transform:translateX(-50%); white-space:nowrap;
              background:#fff; color:${P.primaryFill}; border-radius:999px; padding:30px 58px; font-size:44px; font-weight:900;
              letter-spacing:-0.02em; box-shadow:0 18px 44px rgba(0,0,0,.18); }
  #end .free { position:absolute; left:0; right:0; top:1310px; text-align:center; font-size:34px; font-weight:700; opacity:.9; }
  #end .foot { position:absolute; left:84px; right:84px; bottom:110px; text-align:center; font-size:26px; line-height:1.55; opacity:.78; }

  ${screenCss(P, '#light')}
  ${screenCss(DK, '#dark')}
  `;

  const caps = [
    ['cap2', '', '이평선 분석', '지나온 차트를 되짚어<br>실제로 지켜진 선을 찾아요'],
    ['cap3', '', '오늘의 지지선', '검증된 지지선에 오늘 닿은<br>종목만 골라드려요'],
    ['cap4', 'NEW', '차트 패턴', '교과서 속 차트 모양,<br>지금 만드는 종목을 찾아요'],
    ['cap5', 'NEW', '다크 모드', '밤에 봐도<br>눈이 편하게'],
  ];

  const body = `
  <div id="stage">
    <div id="bg"></div>
    ${caps.map(([id, badge, eb, head]) => `
      <div class="cap" id="${id}">
        <div class="eyebrow">${badge ? `<span class="new">${badge}</span>` : ''}${eb}</div>
        <div class="head">${head}</div>
      </div>`).join('')}
    <div id="phone"><div id="screen">
      <div class="layer" id="light">
        ${chrome(P)}
        <div class="pages">
          ${pageRadar(P, D)}
          ${pageScreener(P, D)}
          ${pagePatterns(P, D, '')}
        </div>
        ${tabBar(P, 1, 'tbL')}
        <div id="touch"></div>
      </div>
      <div class="layer" id="dark">
        ${chrome(DK)}
        <div class="pages">${pagePatterns(DK, D, 'D')}</div>
        ${tabBar(DK, 3, 'tbD')}
      </div>
    </div></div>
    <div id="disc">⚠ ${esc(disclaimer)}</div>

    <div class="blue" id="hook">
      <div class="l1"><span style="position:relative">20일선? 60일선?<i class="strike"></i></span></div>
      <div class="l2">이 종목이 <em>실제로<br>지켜온 선</em>은<br>따로 있어요</div>
    </div>

    <div class="blue" id="end">
      <img class="icon" src="data:image/png;base64,${iconB64}">
      <div class="t">이평선 레이더</div>
      <div class="s">이평선 분석 · 오늘의 지지선 · 차트 패턴</div>
      <div class="cta">토스에서 ‘이평선 레이더’ 검색</div>
      <div class="free">무료로 쓸 수 있어요</div>
      <div class="foot">${esc(env.BRAND_NAME)}<br>⚠ ${esc(env.DISCLAIMER)}</div>
    </div>
  </div>`;

  const script = `
  const D = ${JSON.stringify(D)};
  const PL = ${JSON.stringify(P)};
  const PD = ${JSON.stringify(DK)};
  const Z = ${Z};
  const fmtPrice = ${fmt.fmtPrice.toString()};
  const fmtDate = ${fmt.fmtDateShort.toString()};
  const ORDER = ${JSON.stringify(PATTERN_ORDER)};
  ${PAGE_JS}
  `;

  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
    <body>${body}<script>${script}</script></body></html>`;
}

/* ---------- 페이지 안에서 도는 코드: render(t) 하나로 모든 것이 t 의 함수 ---------- */

// 애니메이션을 CSS transition 으로 두지 않는다 — 프레임을 한 장씩 찍으므로,
// 화면이 '시간 t 에 어떤 모습인가'가 t 만으로 정해져야 매번 같은 영상이 나온다.
const PAGE_JS = String.raw`
const $ = (s) => document.querySelector(s);
const cl = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const seg = (t, a, b) => cl((t - a) / (b - a));
const eOut = (x) => 1 - Math.pow(1 - x, 3);
const eIO = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const eBack = (x) => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const mix = (a, b, k) => a + (b - a) * k;
function mixHex(a, b, k) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return 'rgb(' + pa.map((v, i) => Math.round(mix(v, pb[i], k))).join(',') + ')';
}

// 캔버스: CSS 크기는 논리 pt, 백킹 스토어는 화면 확대(Z)만큼 크게 — 선이 번지지 않는다
for (const cv of document.querySelectorAll('canvas')) {
  const w = +cv.dataset.w, h = +cv.dataset.h;
  cv.style.width = w + 'px'; cv.style.height = h + 'px';
  cv.width = Math.round(w * Z * 1.25); cv.height = Math.round(h * Z * 1.25);
}

// 캔버스 차트 — 앱 CandleChart 와 같은 시각 규약. pr 로 '얼마나 그려졌나'를 받는다.
function drawChart(cv, candles, lines, markers, o, pr) {
  const k = cv.width / +cv.dataset.w;
  const Wd = +cv.dataset.w, Ht = +cv.dataset.h;
  const ctx = cv.getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, Wd, Ht);
  const axisW = o.axis ? 48 : 0;
  const plotW = Wd - axisW, plotH = Ht - (o.dates ? 16 : 0);
  const vis = candles.slice(-o.maxBars);
  const idx = new Map(vis.map((c, i) => [c.time, i]));
  let min = Infinity, max = -Infinity;
  for (const c of vis) { if (c.low < min) min = c.low; if (c.high > max) max = c.high; }
  for (const L of lines) for (const p of L.points) if (idx.has(p.time)) {
    if (p.value < min) min = p.value; if (p.value > max) max = p.value;
  }
  const pad = (max - min) * 0.07 || 1; min -= pad; max += pad;
  const x = (i) => (i + 0.5) * (plotW / vis.length);
  const y = (v) => plotH * (1 - (v - min) / (max - min));
  const font = "500 10px 'Noto Sans KR', sans-serif";
  ctx.lineWidth = 1; ctx.strokeStyle = o.grid; ctx.fillStyle = o.text; ctx.font = font;
  for (let g = 0; g <= 3; g++) {
    const v = max - (max - min) * (g + 0.5) / 4, yy = Math.round(y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
    if (axisW) ctx.fillText(fmtPrice(v), plotW + 6, yy + 3.5);
  }
  // 봉: 왼쪽부터 한 개씩 번져 나온다
  const bw = Math.max(1.2, Math.min(7, (plotW / vis.length) * 0.62));
  const shown = pr.c * vis.length;
  for (let i = 0; i < vis.length; i++) {
    const a = cl(shown - i);
    if (a <= 0) break;
    const c = vis[i];
    const col = c.close >= c.open ? o.up : o.down;
    ctx.globalAlpha = a * (o.candleAlpha ?? 1);
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = Math.max(0.8, bw / 5);
    ctx.beginPath(); ctx.moveTo(x(i), y(c.high)); ctx.lineTo(x(i), y(c.low)); ctx.stroke();
    const top = y(Math.max(c.open, c.close));
    ctx.fillRect(x(i) - bw / 2, top, bw, Math.max(1, y(Math.min(c.open, c.close)) - top));
  }
  ctx.globalAlpha = 1;
  // 선: 왼쪽에서 오른쪽으로 그어진다. 창 밖에서 시작하는 선(패턴 보조선)은 창 경계에서 잘라 그린다
  const firstT = vis[0].time, lastT = vis[vis.length - 1].time;
  const tx = (time) => {
    if (idx.has(time)) return x(idx.get(time));
    if (time < firstT) return x(0) - (plotW / vis.length) * 0; // 창 왼쪽 끝으로 붙인다
    return x(vis.length - 1);
  };
  const cut = pr.l * plotW;
  for (const L of lines) {
    if ((L.alpha ?? 1) <= 0) continue;
    const pts = [];
    for (const p of L.points) {
      if (!idx.has(p.time) && L.points.length > 4) continue; // 이평선: 창 밖 점은 버린다
      pts.push([tx(p.time), y(p.value)]);
    }
    if (L.points.length <= 4 && L.points.length >= 2) {
      // 보조선(두 점짜리 직선): 창 밖 끝점은 직선을 연장해 창 안으로 끌어온다
      const [a, b] = [L.points[0], L.points[L.points.length - 1]];
      const ia = idx.has(a.time) ? idx.get(a.time) : (a.time < firstT ? null : vis.length - 1);
      const ib = idx.has(b.time) ? idx.get(b.time) : (b.time < firstT ? null : vis.length - 1);
      pts.length = 0;
      if (ia === null && ib === null) continue;
      const allTimes = D._timeIndex?.[o.key];
      const gi = (tm) => allTimes ? allTimes.indexOf(tm) : -1;
      let x0, y0v, x1, y1v;
      if (ia === null) {
        // 앞쪽 끝이 창 밖: 전체 봉 배열의 인덱스로 기울기를 구해 창 시작점 값을 계산
        const ga = gi(a.time), gb = gi(b.time), gs = gi(firstT);
        const vS = ga >= 0 && gb > ga ? a.value + (b.value - a.value) * (gs - ga) / (gb - ga) : a.value;
        x0 = x(0); y0v = vS;
      } else { x0 = x(ia); y0v = a.value; }
      x1 = x(ib ?? vis.length - 1); y1v = b.value;
      pts.push([x0, y(y0v)], [x1, y(y1v)]);
    }
    if (pts.length < 2) continue;
    ctx.globalAlpha = L.alpha ?? 1;
    ctx.strokeStyle = L.color; ctx.lineWidth = L.width || 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const [px, py] = pts[i - 1], [qx, qy] = pts[i];
      if (qx <= cut) { ctx.lineTo(qx, qy); continue; }
      if (px < cut) ctx.lineTo(cut, py + (qy - py) * (cut - px) / (qx - px));
      break;
    }
    if (pts[0][0] <= cut) ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // 마커: 시간 순으로 톡톡 튀어나온다
  const ms = (markers || []).filter((m) => idx.has(m.time)).sort((a, b) => (a.time < b.time ? -1 : 1));
  const mShown = pr.m * ms.length;
  ms.forEach((m, n) => {
    const p = cl((mShown - n) * 1.4);
    if (p <= 0 || (m.alpha ?? 1) <= 0) return;
    const s = eBack(p);
    const i = idx.get(m.time), c = vis[i];
    ctx.globalAlpha = cl(p * 2) * (m.alpha ?? 1);
    ctx.fillStyle = m.color;
    ctx.save();
    const up = m.shape === 'arrowUp';
    const my = m.shape === 'circle'
      ? (m.position === 'below' ? y(c.low) + 6 : y(c.high) - 6)
      : (up ? y(c.low) + 4 : y(c.high) - 4);
    ctx.translate(x(i), my); ctx.scale(s, s);
    ctx.beginPath();
    if (m.shape === 'circle') ctx.arc(0, 0, 2.6, 0, 7);
    else if (up) { ctx.moveTo(0, 0); ctx.lineTo(-4, 6.5); ctx.lineTo(4, 6.5); ctx.closePath(); }
    else { ctx.moveTo(0, 0); ctx.lineTo(-4, -6.5); ctx.lineTo(4, -6.5); ctx.closePath(); }
    ctx.fill();
    ctx.restore();
  });
  ctx.globalAlpha = 1;
  if (o.dates) {
    ctx.fillStyle = o.text; ctx.font = font;
    ctx.fillText(fmtDate(vis[0].time), 1, Ht - 3);
    const lt = fmtDate(vis[vis.length - 1].time);
    ctx.fillText(lt, plotW - ctx.measureText(lt).width - 1, Ht - 3);
  }
}

// 패턴 보조선이 창 밖에서 시작할 때 기울기를 구하려고 봉 시각 목록을 둔다
D._timeIndex = {};
for (const k of ORDER) D._timeIndex[k] = D.patterns[k].candles.map((c) => c.time);

const radarMarkers = (P, focus) => {
  const out = [];
  D.radar.recs.forEach((rec, i) => {
    for (const ev of rec.events) {
      const sup = ev.side === 'support', brk = ev.outcome === 'break';
      out.push({
        time: ev.time, position: sup ? 'below' : 'above',
        shape: brk ? 'circle' : sup ? 'arrowUp' : 'arrowDown',
        color: brk ? (sup ? P.events.breakDown : P.events.breakUp) : (sup ? P.events.support : P.events.resistance),
        rec: i,
      });
    }
  });
  return out;
};

/* ---- 타임라인 (초) ---- */
const T = {
  hookOut: [2.75, 3.3], phoneIn: [2.95, 3.8],
  cap2: [3.35, 3.75, 9.25, 9.55], cap3: [9.55, 9.9, 14.55, 14.85],
  cap4: [14.85, 15.2, 20.95, 21.25], cap5: [21.25, 21.6, 99, 99],
  toScreener: 9.45, toPatterns: 14.8, dark: [21.3, 22.4], end: [23.9, 24.45],
};
const TAPS = [
  // [시각, 화면 좌표(논리 pt) x, y]
  [7.75, 0, 0, 'rec30'],
  [9.2, 3 * 75 - 37.5, ${LH} - 29, 'tab'],
  [14.55, 4 * 75 - 37.5, ${LH} - 29, 'tab'],
  [16.75, 0, 0, 'chip1'],
  [18.75, 0, 0, 'chip2'],
];

function capAt(el, t, [a, b, c, d]) {
  const inK = eOut(seg(t, a, b)), outK = eIO(seg(t, c, d));
  el.style.opacity = inK * (1 - outK);
  el.style.transform = 'translateY(' + (mix(34, 0, inK) - 26 * outK) + 'px)';
}

function page(el, t, tin, tout) {
  // tin 에 들어오고 tout 에 나간다 (둘 다 0.3초짜리 옆으로 미끄러짐)
  const i = tin == null ? 1 : eOut(seg(t, tin, tin + 0.32));
  const o = tout == null ? 0 : eIO(seg(t, tout, tout + 0.3));
  el.style.opacity = i * (1 - o);
  el.style.transform = 'translateX(' + (mix(28, 0, i) - 28 * o) + 'px)';
}

function setTab(tbId, active, P) {
  document.querySelectorAll('#' + tbId + ' .tab').forEach((tab) => {
    const on = +tab.dataset.i === active;
    tab.style.color = on ? P.text : P.faint;
    tab.querySelector('b').style.fontWeight = on ? 700 : 500;
  });
}

function patternAt(t) {
  if (t < 16.95) return { key: 'stage2', since: 15.05 };
  if (t < 18.95) return { key: 'triangle', since: 16.95 };
  return { key: 'cup_handle', since: 18.95 };
}

function drawPattern(suffix, key, P, since, t) {
  const m = D.patterns[key];
  const cv = document.getElementById('cvP_' + key + suffix);
  const pr = { c: eIO(seg(t, since + 0.1, since + 0.95)), l: eIO(seg(t, since + 0.85, since + 1.55)), m: 0 };
  drawChart(cv, m.candles, m.overlays.map((ov, i) => ({ color: P.ma[i % P.ma.length], points: ov.points, width: 2.2 })),
    [], { maxBars: 200, grid: P.grid, text: P.faint, up: P.up, down: P.down, dates: false, key }, pr);
}

// offsetTop 은 zoom 안쪽에서 브라우저마다 단위가 달라 믿지 않는다 — 둘 다 화면 좌표로 재서 뺀다
let SCROLL_BY = null;
function screenerScroll() {
  if (SCROLL_BY != null) return SCROLL_BY;
  const list = $('#scrList');
  list.style.transform = 'none';
  const pages = document.querySelector('#light .pages').getBoundingClientRect();
  const c2 = document.querySelectorAll('#pgScreener .mcard')[1].getBoundingClientRect();
  SCROLL_BY = Math.max(0, (c2.bottom - pages.bottom) / Z + 14);
  return SCROLL_BY;
}
function tapPoint(kind) {
  const scr = $('#light').getBoundingClientRect();
  const zoomed = (el) => {
    const r = el.getBoundingClientRect();
    // getBoundingClientRect 는 zoom 이 반영된 화면 좌표다 → 논리 pt 로 되돌린다
    return [(r.left - scr.left + r.width / 2) / Z, (r.top - scr.top + r.height / 2) / Z];
  };
  if (kind === 'rec30') return zoomed(document.querySelectorAll('#pgRadar .rec')[3]);
  if (kind === 'chip1') return zoomed(document.querySelectorAll('#pgPatterns .chip')[1]);
  if (kind === 'chip2') return zoomed(document.querySelectorAll('#pgPatterns .chip')[2]);
  return null;
}

window.render = function render(t) {
  const P = PL;

  /* 훅 · 엔드 패널 */
  const hook = $('#hook');
  const hOut = eIO(seg(t, ...T.hookOut));
  hook.style.transform = 'translateY(' + (-${H} * hOut) + 'px)';
  hook.style.display = hOut >= 1 ? 'none' : 'block';
  const l1 = $('#hook .l1');
  const k1 = eOut(seg(t, 0.15, 0.65));
  l1.style.opacity = k1 * mix(1, 0.42, eIO(seg(t, 1.3, 1.65)));
  l1.style.transform = 'translateY(' + mix(60, 0, k1) + 'px)';
  $('#hook .strike').style.width = (100 * eIO(seg(t, 1.2, 1.6))) + '%';
  const k2 = eOut(seg(t, 1.55, 2.1));
  const l2 = $('#hook .l2');
  l2.style.opacity = k2; l2.style.transform = 'translateY(' + mix(70, 0, k2) + 'px)';

  const end = $('#end');
  const eIn = eIO(seg(t, ...T.end));
  end.style.display = eIn <= 0 ? 'none' : 'block';
  end.style.transform = 'translateY(' + (-${H} * (1 - eIn)) + 'px)';
  const pop = (sel, a, b, dy, scale) => {
    const k = seg(t, a, b), el = $('#end ' + sel);
    el.style.opacity = cl(k * 1.6);
    const s = scale ? mix(0.6, 1, eBack(k)) : 1;
    const base = sel === '.cta' ? 'translateX(-50%) ' : '';
    el.style.transform = base + 'translateY(' + mix(dy, 0, eOut(k)) + 'px) scale(' + s + ')';
  };
  pop('.icon', 24.35, 24.85, 0, true);
  pop('.t', 24.55, 25.0, 50);
  pop('.s', 24.75, 25.2, 40);
  pop('.cta', 25.05, 25.55, 40, true);
  pop('.free', 25.35, 25.75, 30);
  pop('.foot', 25.5, 25.9, 20);

  /* 배경 · 자막 색 (다크 모드 장면에서 함께 어두워진다) */
  const dk = eIO(seg(t, T.dark[0] + 0.1, T.dark[1] - 0.1));
  $('#bg').style.background = mixHex(P.bg, PD.bg, dk);
  document.documentElement.style.setProperty('--capText', mixHex(P.text, PD.text, dk));
  document.documentElement.style.setProperty('--discText', mixHex(P.faint, PD.faint, dk));
  $('#cap5 .eyebrow').style.color = mixHex(P.primary, PD.primary, dk);

  capAt($('#cap2'), t, T.cap2); capAt($('#cap3'), t, T.cap3);
  capAt($('#cap4'), t, T.cap4); capAt($('#cap5'), t, T.cap5);

  /* 폰 */
  const ph = $('#phone');
  const pIn = eOut(seg(t, ...T.phoneIn));
  ph.style.transform = 'translateY(' + mix(${H - PHONE_TOP + 40}, 0, pIn) + 'px)';
  $('#disc').style.opacity = eOut(seg(t, 3.6, 4.1));

  /* 탭 */
  const tabIdx = t < T.toScreener ? 1 : t < T.toPatterns ? 2 : 3;
  setTab('tbL', tabIdx, P);

  /* 페이지 1: 이평선 분석 */
  page($('#pgRadar'), t, null, T.toScreener);
  const focus = t >= 7.9;                       // MA 30 카드를 눌러 그 선만 본다
  const fk = eIO(seg(t, 7.9, 8.2));
  const recs = document.querySelectorAll('#pgRadar .rec');
  recs.forEach((el, n) => {
    const i = n - 1;                            // 0번은 '동시 보기'
    const k = eOut(seg(t, 3.6 + n * 0.09, 4.05 + n * 0.09));
    const dim = focus && i !== 2;
    el.style.opacity = k * (dim ? mix(1, 0.55, fk) : 1);
    el.style.transform = 'translateY(' + mix(16, 0, k) + 'px)';
    if (i === -1) el.style.background = mixHex(P.primaryBg, P.card, fk);
    if (i === 2) el.style.background = mixHex(P.card, P.primaryBg, fk);
    const hint = el.querySelector('.rh');
    if (i === -1) hint.textContent = focus ? '누르면 전체 표시' : '지금 보는 중';
    if (i === 2) hint.textContent = focus ? '누르면 전체 보기' : '누르면 이 선만 보기';
  });
  const r = D.radar;
  const lines = r.recs.map((rec, i) => ({
    color: P.ma[i % P.ma.length], points: rec.ma, width: 2,
    alpha: focus && i !== 2 ? 1 - fk : 1,
  }));
  const markers = radarMarkers(P).map((m) => ({ ...m, alpha: focus && m.rec !== 2 ? 1 - fk : 1 }));
  drawChart($('#cvRadar'), r.candles, lines, markers,
    { maxBars: 64, axis: true, dates: true, grid: P.grid, text: P.faint, up: P.up, down: P.down },
    { c: eIO(seg(t, 3.9, 5.2)), l: eIO(seg(t, 5.0, 6.3)), m: seg(t, 6.1, 7.3) });
  $('#legRadar').style.opacity = eOut(seg(t, 6.9, 7.3));

  /* 페이지 2: 오늘의 지지선 */
  page($('#pgScreener'), t, T.toScreener + 0.05, T.toPatterns);
  const scroll = eIO(seg(t, 11.9, 13.1));
  $('#scrList').style.transform = 'translateY(' + (-screenerScroll() * scroll) + 'px)';
  D.touches.slice(0, 2).forEach((m, i) => {
    const st = i === 0 ? 9.95 : 12.3;
    const bar = document.getElementById('mt' + i);
    bar.style.width = (+bar.dataset.pct * eOut(seg(t, st, st + 0.8))) + '%';
    drawChart(document.getElementById('cvM' + i), m.candles,
      [{ color: P.ma[0], points: m.maLine, width: 2 }],
      [{ time: m.candles[m.candles.length - 1].time, shape: 'arrowUp', position: 'below', color: P.primary }],
      { maxBars: 40, dates: true, grid: P.grid, text: P.faint, up: P.up, down: P.down },
      { c: eIO(seg(t, st + 0.1, st + 0.9)), l: eIO(seg(t, st + 0.7, st + 1.3)), m: seg(t, st + 1.2, st + 1.5) });
  });

  /* 페이지 3: 차트 패턴 */
  page($('#pgPatterns'), t, T.toPatterns + 0.05, null);
  const cur = patternAt(t);
  document.querySelectorAll('#pgPatterns .chip').forEach((c) => c.classList.toggle('on', c.dataset.key === cur.key));
  document.querySelectorAll('#pgPatterns .pblock').forEach((b) => {
    const on = b.dataset.key === cur.key;
    const k = on ? (cur.key === 'stage2' ? 1 : eOut(seg(t, cur.since, cur.since + 0.3))) : 0;
    b.style.opacity = k;
    b.style.transform = 'translateY(' + mix(14, 0, k) + 'px)';
  });
  drawPattern('', cur.key, P, cur.since, t);

  /* 다크 모드: 오른쪽 위에서 원이 번지며 화면이 바뀐다 */
  const dr = eIO(seg(t, ...T.dark));
  $('#dark').style.clipPath = 'circle(' + (dr * 900) + 'px at 330px 70px)';
  $('#dark').style.display = dr > 0 ? 'block' : 'none';
  if (dr > 0) {
    document.querySelectorAll('#pgPatternsD .chip').forEach((c) => c.classList.toggle('on', c.dataset.key === 'cup_handle'));
    document.querySelectorAll('#pgPatternsD .pblock').forEach((b) => { b.style.opacity = b.dataset.key === 'cup_handle' ? 1 : 0; });
    drawPattern('D', 'cup_handle', PD, 18.95, 99);
  }

  /* 누르는 손가락 자국 */
  const touch = $('#touch');
  touch.style.opacity = 0;
  for (const [at, tx, ty, kind] of TAPS) {
    const k = seg(t, at - 0.12, at + 0.33);
    if (k <= 0 || k >= 1) continue;
    const pt = kind === 'tab' ? [tx, ty] : tapPoint(kind);
    touch.style.left = pt[0] + 'px'; touch.style.top = pt[1] + 'px';
    touch.style.opacity = Math.sin(Math.PI * k) * 0.9;
    touch.style.transform = 'scale(' + mix(0.55, 1.15, eOut(k)) + ')';
  }
};
window.render(0);
`;

/* ---------- 렌더링 ---------- */

function findChromium() {
  if (process.env.CHROMIUM_PATH) return { executablePath: process.env.CHROMIUM_PATH };
  if (fs.existsSync('/opt/pw-browsers/chromium')) return { executablePath: '/opt/pw-browsers/chromium' };
  return { channel: 'chrome' };
}

async function render(opts) {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(`${DATA_FILE} 가 없다 — 먼저 --fetch 로 받는다`);
  }
  const D = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const html = buildHtml(ensureFonts(), D);
  const htmlPath = path.join(HERE, 'store', 'promo_preview.html');
  fs.writeFileSync(htmlPath, html);

  const browser = await chromium.launch(findChromium());
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  let pageError = null;
  page.on('pageerror', (err) => { pageError = err; });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  if (pageError) throw pageError;

  const snap = async (t) => {
    await page.evaluate((tt) => window.render(tt), t);
    if (pageError) throw pageError;
    return page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
  };

  if (opts.frames) {
    const dir = path.join(APP, 'store', 'promo_frames');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of opts.frames) {
      const file = path.join(dir, `f${String(f).padStart(4, '0')}.png`);
      fs.writeFileSync(file, await snap(f / FPS));
      console.log(`frame ${f} (${(f / FPS).toFixed(2)}s) → ${file}`);
    }
    await browser.close();
    return;
  }

  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const music = path.join(HERE, 'store', 'promo_music.wav');
  if (!fs.existsSync(music)) {
    console.log('배경음악이 없어 먼저 만든다 (make_promo_music.py)…');
    execFileSync('python3', [path.join(HERE, 'make_promo_music.py')], { stdio: 'inherit' });
  }
  const total = Math.round(DURATION * FPS);
  const ff = spawn(ffmpeg, [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
    '-i', music,
    '-map', '0:v', '-map', '1:a', '-shortest',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p',
    '-profile:v', 'high', '-level', '4.2', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    OUT_FILE,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg 종료 코드 ${code}`)))));

  const started = Date.now();
  for (let f = 0; f < total; f++) {
    const buf = await snap(f / FPS);
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (f % 60 === 0) {
      const el = (Date.now() - started) / 1000;
      console.log(`  ${f}/${total} 프레임 · ${el.toFixed(0)}초 경과`);
    }
  }
  ff.stdin.end();
  await done;
  await browser.close();
  fs.rmSync(htmlPath, { force: true });
  console.log(`OK: ${OUT_FILE} (${(fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(1)} MB, ${DURATION}s, ${W}x${H}@${FPS})`);
}

/* ---------- main ---------- */

const args = process.argv.slice(2);
if (args.includes('--fetch')) {
  const pi = args.indexOf('--pick');
  const pick = {};
  if (pi >= 0) for (const kv of args[pi + 1].split(',')) { const [k, v] = kv.split('='); pick[k] = Number(v); }
  fetchData(pick);
} else {
  const fi = args.indexOf('--frames');
  const frames = fi >= 0 ? args[fi + 1].split(',').map(Number) : null;
  await render({ frames });
}
