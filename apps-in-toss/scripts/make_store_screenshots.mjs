/**
 * 스토어 등록용 스크린샷 생성 — 앱의 팔레트·문구·포맷 함수를 '그대로 import' 해서
 * HTML 로 앱 화면을 재현하고 Chromium 으로 규격에 맞춰 찍는다.
 *
 * 규격: 세로 636×1048 (3장 이상) · 가로 1504×741 (1장 이상) — 규격 밖은 안 세어짐.
 *
 * 사용 (저장소 루트에서):
 *   python apps-in-toss/scripts/store_screenshot_data.py   # 엔진에서 데이터 추출
 *   node apps-in-toss/scripts/make_store_screenshots.mjs   # PNG 5장 생성 → apps-in-toss/store/
 *
 * 숫자·색·문구의 출처:
 *   - 색: src/theme.ts 의 LIGHT 팔레트 (transpile 해서 실제 값 사용)
 *   - 문구: src/env.ts (LOOKBACK_LABEL·SCREENER_RULE_LABEL·DISCLAIMER·브랜드)
 *   - 숫자 포맷: src/format.ts 의 fmtPrice/fmtRate/fmtDistPct (같은 함수 실행)
 *   - 수치·차트: scripts/store/data.json (백테스트 엔진의 실제 출력)
 *   - 대표 종목 칩: src/pages/index.tsx 의 QUICK_PICKS 배열을 파싱
 *
 * Chromium 경로: 환경변수 CHROMIUM_PATH > /opt/pw-browsers/chromium > 설치된 Chrome.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const OUT_DIR = path.join(APP, 'store');
const DATA = JSON.parse(fs.readFileSync(path.join(HERE, 'store', 'data.json'), 'utf8'));

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

const theme = loadTS('src/theme.ts', { 'react-native': { useColorScheme: () => 'light' } });
const env = loadTS('src/env.ts');
const fmt = loadTS('src/format.ts');
const P = theme.LIGHT; // 스토어 스크린샷은 라이트 테마 기준

// index.tsx 의 QUICK_PICKS 배열 리터럴을 그대로 파싱 (출처 단일화)
const indexSrc = fs.readFileSync(path.join(APP, 'src', 'pages', 'index.tsx'), 'utf8');
const qpMatch = indexSrc.match(/const QUICK_PICKS[^=]*=\s*(\[[\s\S]*?\]);/);
if (!qpMatch) throw new Error('index.tsx 에서 QUICK_PICKS 를 찾지 못함');
const QUICK_PICKS = new Function(`return ${qpMatch[1]}`)();

/* ---------- 한글 폰트: 구글 폰트를 내려받아 로컬 파일로 embed ---------- */
/* 컨테이너에는 한글 폰트가 없고 페이지 네트워크도 프록시에 막히므로, curl 로
   미리 받아 file:// 로 물린다. 실패하면 시스템 폰트(맥: Apple SD Gothic Neo)로 폴백. */

function ensureFonts() {
  const dir = path.join(HERE, 'store', 'fonts');
  const cssPath = path.join(dir, 'fonts.css');
  if (fs.existsSync(cssPath)) return fs.readFileSync(cssPath, 'utf8');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const cssUrl =
      'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&display=block';
    let css = execFileSync('curl', ['-sf', '-A', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120', cssUrl], {
      encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
    });
    // UA 에 따라 woff2 조각 수십 개 또는 가중치별 ttf 가 온다 — 둘 다 처리
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
  } catch (err) {
    console.warn(`폰트 다운로드 실패(시스템 폰트로 폴백): ${err.message}`);
    return '';
  }
}

/* ---------- 공용 스타일/컴포넌트 ---------- */

const FONT_STACK = `'Noto Sans KR','Apple SD Gothic Neo','Malgun Gothic',sans-serif`;

function baseCss(fontCss) {
  return `
  ${fontCss}
  * { box-sizing: border-box; margin: 0; }
  body { font-family: ${FONT_STACK}; background: ${P.bg}; color: ${P.text};
         -webkit-font-smoothing: antialiased; overflow: hidden; }
  .cap { padding: 44px 40px 24px; }
  .eyebrow { font-size: 20px; font-weight: 700; color: ${P.up}; letter-spacing: .06em; margin-bottom: 10px; }
  .headline { font-size: 43px; font-weight: 900; line-height: 1.24; letter-spacing: -0.02em; }
  .subline { font-size: 21px; color: ${P.sub}; margin-top: 12px; line-height: 1.45; }
  .panel { margin: 8px 28px 0; background: ${P.card}; border: 2px solid ${P.border};
           border-radius: 28px; padding: 26px; display: flex; flex-direction: column; gap: 18px; }
  .chip { display: inline-flex; align-items: center; font-size: 19px; padding: 9px 18px;
          border-radius: 999px; border: 2px solid ${P.border}; background: ${P.card}; color: ${P.text}; }
  .chip.on { border-color: ${P.up}; background: ${P.emeraldBg}; color: ${P.up}; font-weight: 700; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .card { background: ${P.card}; border: 2px solid ${P.border}; border-radius: 18px; padding: 16px; }
  .small { font-size: 16px; color: ${P.faint}; line-height: 1.5; }
  .foot { position: absolute; left: 40px; right: 40px; bottom: 26px; font-size: 15px;
          color: ${P.faint}; line-height: 1.5; }
  .dot { display: inline-block; width: 13px; height: 13px; border-radius: 7px; margin-right: 8px; }
  .meter { height: 10px; border-radius: 5px; background: ${P.border}; overflow: hidden; }
  .meter > i { display: block; height: 10px; background: ${P.up}; }
  `;
}

// 캔들차트 그리기 (페이지 안에서 실행) — 앱 CandleChart 와 같은 시각 규약
const CHART_JS = `
function drawChart(id, candles, lines, markers, opts) {
  opts = opts || {};
  const cv = document.getElementById(id);
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const axisW = opts.axis === false ? 0 : 86;
  const plotW = W - axisW, plotH = H - (opts.dates === false ? 0 : 26);
  const maxBars = opts.maxBars || 120;
  const vis = candles.length > maxBars ? candles.slice(-maxBars) : candles;
  const idx = new Map(vis.map((c, i) => [c.time, i]));
  let min = Infinity, max = -Infinity;
  for (const c of vis) { if (c.low < min) min = c.low; if (c.high > max) max = c.high; }
  for (const L of lines) for (const p of L.points) if (idx.has(p.time)) {
    if (p.value < min) min = p.value; if (p.value > max) max = p.value;
  }
  const pad = (max - min) * 0.06 || 1; min -= pad; max += pad;
  const x = (i) => (i + 0.5) * (plotW / vis.length);
  const y = (v) => plotH * (1 - (v - min) / (max - min));
  ctx.strokeStyle = opts.grid; ctx.lineWidth = 1; ctx.fillStyle = opts.textColor;
  ctx.font = (opts.axisFont || 15) + 'px sans-serif';
  for (let k = 0; k <= 4; k++) {
    const v = max - (max - min) * k / 4, yy = Math.round(y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
    if (axisW) ctx.fillText(opts.fmtPrice(v), plotW + 8, Math.min(plotH - 4, Math.max(14, yy + 5)));
  }
  const bw = Math.max(2, Math.min(14, (plotW / vis.length) * 0.62));
  vis.forEach((c, i) => {
    const color = c.close >= c.open ? opts.up : opts.down;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = Math.max(1.5, bw / 6);
    ctx.beginPath(); ctx.moveTo(x(i), y(c.high)); ctx.lineTo(x(i), y(c.low)); ctx.stroke();
    const top = y(Math.max(c.open, c.close));
    ctx.fillRect(x(i) - bw / 2, top, bw, Math.max(2, y(Math.min(c.open, c.close)) - top));
  });
  for (const L of lines) {
    ctx.strokeStyle = L.color; ctx.lineWidth = L.width || 3;
    ctx.lineJoin = 'round'; ctx.beginPath();
    let started = false;
    for (const p of L.points) {
      const i = idx.get(p.time);
      if (i === undefined) continue;
      if (!started) { ctx.moveTo(x(i), y(p.value)); started = true; }
      else ctx.lineTo(x(i), y(p.value));
    }
    ctx.stroke();
  }
  for (const m of (markers || [])) {
    const i = idx.get(m.time);
    if (i === undefined) continue;
    const c = vis[i];
    ctx.fillStyle = m.color;
    if (m.shape === 'circle') {
      const my = m.position === 'below' ? y(c.low) + 10 : y(c.high) - 10;
      ctx.beginPath(); ctx.arc(x(i), my, 5, 0, 7); ctx.fill();
    } else {
      const up = m.shape === 'arrowUp';
      const my = up ? Math.min(plotH - 4, y(c.low) + 6) : Math.max(14, y(c.high) - 6);
      ctx.beginPath();
      ctx.moveTo(x(i), up ? my : my);
      if (up) { ctx.moveTo(x(i), my); ctx.lineTo(x(i) - 7, my + 11); ctx.lineTo(x(i) + 7, my + 11); }
      else { ctx.moveTo(x(i), my); ctx.lineTo(x(i) - 7, my - 11); ctx.lineTo(x(i) + 7, my - 11); }
      ctx.closePath(); ctx.fill();
    }
  }
  if (opts.dates !== false) {
    ctx.fillStyle = opts.textColor; ctx.font = (opts.axisFont || 15) + 'px sans-serif';
    const first = vis[0], last = vis[vis.length - 1];
    ctx.fillText(opts.fmtDate(first.time), 2, H - 8);
    const lt = opts.fmtDate(last.time);
    ctx.fillText(lt, plotW - ctx.measureText(lt).width - 2, H - 8);
  }
}
`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page(fontCss, extraCss, body, script) {
  // IIFE 로 감싼다 — setContent 는 같은 문서에 다시 쓰므로 전역 const 가
  // 이전 화면에서 남아 재선언 오류로 스크립트 전체(차트 포함)가 죽는다
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss(fontCss)}${extraCss || ''}</style></head>
  <body>${body}<script>(() => {
  const fmtHelpers = { fmtPrice: ${fmt.fmtPrice.toString()}, fmtDate: ${fmt.fmtDateShort.toString()} };
  ${CHART_JS}${script || ''}})()</script></body></html>`;
}

/* ---------- 데이터 가공 (앱과 같은 계산) ---------- */

const day = DATA.radar.timeframes.day;
const recs = day.recommended || [];
const eventCounts = (events) => ({
  breakDown: events.filter((e) => e.outcome === 'break' && e.side === 'support').length,
  breakUp: events.filter((e) => e.outcome === 'break' && e.side === 'resistance').length,
});
const chartMarkers = (visibleRecs) => {
  const out = [];
  for (const rec of visibleRecs)
    for (const ev of rec.events) {
      if (ev.outcome === 'undecided') continue;
      const isSupport = ev.side === 'support';
      const failed = ev.outcome === 'break';
      out.push({
        time: ev.time,
        position: isSupport ? 'below' : 'above',
        shape: failed ? 'circle' : isSupport ? 'arrowUp' : 'arrowDown',
        color: failed
          ? (isSupport ? P.events.breakDown : P.events.breakUp)
          : (isSupport ? P.events.support : P.events.resistance),
      });
    }
  return out.slice(-120);
};
const windowNote =
  `분석 구간: ${day.windowStart} ~ ${day.windowEnd} (일봉 ${day.bars}개` +
  (day.lookbackYears ? `, 약 ${day.lookbackYears}년` : ', 전체 기간') +
  `) · 최근 가중 반감기 ${day.halfLifeBars}봉`;

const recCard = (rec, i, wide) => {
  const color = P.ma[i % P.ma.length];
  const { breakDown, breakUp } = eventCounts(rec.events);
  return `<div class="card" style="min-width:${wide ? 260 : 246}px;padding:14px">
    <div style="font-size:23px;font-weight:800"><span class="dot" style="background:${color}"></span>MA ${rec.period}</div>
    <div class="small" style="margin-top:5px;white-space:nowrap">터치 ${rec.touches}회 · 성공률 ${fmt.fmtRate(rec.successRate)}</div>
    <div class="small" style="margin-top:2px;font-size:15px;white-space:nowrap"><span style="color:${P.events.support}">지지 ${rec.supportBounces}</span> · <span style="color:${P.events.resistance}">저항 ${rec.resistanceBounces}</span> · <span style="color:${P.events.breakDown}">이탈 ${breakDown}</span> · <span style="color:${P.events.breakUp}">돌파 ${breakUp}</span></div>
  </div>`;
};

const matchCard = (m, chartId) => `
  <div class="card" style="display:flex;flex-direction:column;gap:10px">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font-size:23px"><b>${esc(m.name)}</b>
        <span class="small">${esc(m.symbol)}${m.market ? ' · ' + esc(m.market) : ''}</span></div>
      <span style="background:${P.emeraldBg};color:${P.up};font-weight:800;font-size:19px;
        border-radius:10px;padding:4px 12px">MA ${m.period}</span>
    </div>
    <div class="meter"><i style="width:${Math.max(0, Math.min(100, Math.round(m.successRate * 100)))}%"></i></div>
    <div class="small" style="font-size:16px;color:${P.sub}">3년 지지 성공률 <b style="color:${P.text}">${fmt.fmtRate(m.successRate)}</b>
      · 지지 성공 ${m.supportBounces}회 (터치 ${m.touches}회) ·
      오늘 종가는 선 대비 <b style="color:${P.text}">${fmt.fmtDistPct(m.distPct)}</b> (선 ${fmt.fmtPrice(m.maValue)})</div>
    <canvas id="${chartId}" width="512" height="132"></canvas>
  </div>`;

/* ---------- 화면 5장 ---------- */

function screenRadar(fontCss) {
  // 카드로 보여주는 상위 2개 이평선만 차트에도 그린다 — 카드와 차트가 어긋나지 않게
  const lines = recs.slice(0, 2).map((rec, i) => ({ color: P.ma[i % P.ma.length], points: rec.ma, width: 3 }));
  return page(fontCss, '', `
    <div class="cap">
      <div class="eyebrow">📈 이평선 레이더</div>
      <div class="headline">이 종목이 실제로 지켜온<br>이평선을 찾아드려요</div>
      <div class="subline">${esc(env.LOOKBACK_LABEL)} 백테스트</div>
    </div>
    <div class="panel">
      <div class="row" style="justify-content:space-between">
        <div style="font-size:26px;font-weight:800">${esc(DATA.radar.name)} <span class="small">${esc(DATA.radar.symbol)} · ${esc(DATA.radar.market)}</span></div>
        <div class="row"><span class="chip on">일봉</span><span class="chip">주봉</span><span class="chip">월봉</span></div>
      </div>
      <div class="row" style="flex-wrap:nowrap;overflow:hidden">${recs.slice(0, 2).map((r, i) => recCard(r, i)).join('')}</div>
      <canvas id="chart" width="524" height="400"></canvas>
      <div class="small">${esc(windowNote)}</div>
    </div>
    <div class="foot">▲=지지 성공 · ▼=저항 성공 · ●=뚫림 · ⚠ ${esc(env.DISCLAIMER)}</div>
  `, `drawChart('chart', ${JSON.stringify(day.candles.slice(-120))}, ${JSON.stringify(lines.map((l) => ({ ...l, points: l.points.slice(-140) })))},
      ${JSON.stringify(chartMarkers(recs.slice(0, 2)))},
      { up:'${P.up}', down:'${P.down}', grid:'${P.grid}', textColor:'${P.faint}',
        maxBars:120, fmtPrice: fmtHelpers.fmtPrice, fmtDate: fmtHelpers.fmtDate });`);
}

function screenScore(fontCss) {
  const recoSet = new Set(recs.map((r) => r.period));
  const rows = [...day.stats].sort((a, b) => b.score - a.score);
  const tr = (s) => {
    const isReco = recoSet.has(s.period);
    const dim = !isReco && (s.insufficientData || !s.touches);
    return `<tr style="${isReco ? `background:${P.emeraldBg};font-weight:700` : ''};opacity:${dim ? 0.55 : 1}">
      <td>MA ${s.period}${isReco ? ' ★' : ''}</td>
      <td>${s.insufficientData ? '데이터 부족' : s.touches}</td>
      <td>${s.supportBounces}</td><td>${s.resistanceBounces}</td><td>${s.breaks}</td>
      <td>${s.insufficientData ? '—' : fmt.fmtRate(s.successRate)}</td>
      <td>${s.score.toFixed(3)}</td></tr>`;
  };
  return page(fontCss, `
    table { border-collapse: collapse; width: 100%; font-size: 19px; }
    th { font-size: 16px; color: ${P.faint}; text-align: left; padding: 10px 8px; border-bottom: 2px solid ${P.border}; }
    td { padding: 11px 8px; border-bottom: 1.5px solid ${P.border}; }
  `, `
    <div class="cap">
      <div class="eyebrow">📊 전체 후보 성적표</div>
      <div class="headline">근거를 전부<br>보여드려요</div>
      <div class="subline">터치 → 반등/뚫림 판정 → Wilson 점수, 기준 공개</div>
    </div>
    <div class="panel">
      <div style="font-size:24px;font-weight:800">${esc(DATA.radar.name)} · 일봉</div>
      <table>
        <tr><th>이평선</th><th>터치</th><th>지지</th><th>저항</th><th>돌파(실패)</th><th>성공률</th><th>점수</th></tr>
        ${rows.map(tr).join('')}
      </table>
      <div class="small">★ = 추천 이평선 · 점수 = 가중 성공률의 Wilson 신뢰하한 × log(1+가중 성공 횟수)</div>
    </div>
    <div class="foot">⚠ ${esc(env.DISCLAIMER)}</div>
  `);
}

function screenScreener(fontCss) {
  const ms = DATA.screener.matches.slice(0, 2);
  const scripts = ms.map((m, i) => {
    const markers = m.todayTouch !== false && m.candles.length
      ? [{ time: m.candles[m.candles.length - 1].time, shape: 'arrowUp', position: 'below', color: P.indigo }]
      : [];
    return `drawChart('m${i}', ${JSON.stringify(m.candles.slice(-40))},
      [{ color:'${P.amber}', width:3, points: ${JSON.stringify(m.maLine.slice(-46))} }],
      ${JSON.stringify(markers)},
      { up:'${P.up}', down:'${P.down}', grid:'${P.grid}', textColor:'${P.faint}',
        maxBars:40, axis:false, fmtPrice: fmtHelpers.fmtPrice, fmtDate: fmtHelpers.fmtDate });`;
  }).join('\n');
  return page(fontCss, '', `
    <div class="cap">
      <div class="eyebrow">🚨 오늘의 지지선 터치</div>
      <div class="headline">검증된 지지선에<br>닿은 종목만</div>
      <div class="subline">${esc(env.SCREENER_RULE_LABEL)} 골라드려요</div>
    </div>
    <div class="panel" style="gap:14px">
      <div class="row"><span class="chip on">🇰🇷 국내</span><span class="chip">🇺🇸 미국</span></div>
      ${ms.map((m, i) => matchCard(m, `m${i}`)).join('')}
    </div>
    <div class="foot">⚠ ${esc(env.DISCLAIMER.split('. ')[0])}.</div>
  `, scripts);
}

function screenStart(fontCss) {
  return page(fontCss, '', `
    <div class="cap">
      <div class="eyebrow">🔍 종목 검색</div>
      <div class="headline">검색 한 번에<br>일·주·월봉을 한꺼번에</div>
      <div class="subline">국내 전 종목 이름 검색 + 미국 티커 지원 · 무료</div>
    </div>
    <div class="panel" style="gap:16px">
      <div style="border:2px solid ${P.border};border-radius:14px;padding:16px 18px;font-size:21px;color:${P.faint}">
        종목 이름 · 코드 · 미국 티커 (예: 삼성전자, AAPL)</div>
      <div class="row">${QUICK_PICKS.map((q, i) =>
        `<span class="chip${i === 0 ? ' on' : ''}">${esc(q.name)}</span>`).join('')}</div>
      <div style="background:${P.up};color:#fff;border-radius:14px;text-align:center;
        font-size:23px;font-weight:800;padding:16px">분석</div>
      <div class="card" style="display:flex;flex-direction:column;gap:8px">
        <div style="font-size:21px;font-weight:800">어떻게 쓰나요?</div>
        <div class="small" style="font-size:18px;line-height:1.65">
          1. 종목을 검색하거나 대표 종목을 누르세요<br>
          2. 일·주·월봉별로 자주, 믿을 만하게 지지/저항이 된 이평선 2~3개를 백테스트로 찾아 차트에 그려드려요<br>
          3. 남들이 쓰는 20·60일선이 아니라, 이 종목이 실제로 지켜온 선을 확인하세요</div>
      </div>
    </div>
    <div class="foot">${esc(env.BRAND_NAME)} · 문의 ${esc(env.CONTACT_EMAIL)} · ⚠ ${esc(env.DISCLAIMER)}</div>
  `);
}

function screenWide(fontCss) {
  const iconB64 = fs.readFileSync(path.resolve(APP, '..', 'static', 'icon.png')).toString('base64');
  const lines = recs.slice(0, 2).map((rec, i) => ({ color: P.ma[i % P.ma.length], points: rec.ma.slice(-100), width: 3 }));
  const m = DATA.screener.matches[0];
  return page(fontCss, `
    body { background: linear-gradient(135deg, #10b981, #047857); }
    .wrap { display: flex; align-items: center; gap: 48px; padding: 56px 64px; height: 741px; }
  `, `
    <div class="wrap">
      <div style="flex:1;color:#fff">
        <img src="data:image/png;base64,${iconB64}" width="132" height="132" style="border-radius:30px;box-shadow:0 12px 40px rgba(0,0,0,.25)">
        <div style="font-size:64px;font-weight:900;margin-top:26px;letter-spacing:-0.02em">이평선 레이더</div>
        <div style="font-size:27px;margin-top:14px;opacity:.94;line-height:1.5">
          지지/저항 이평선 백테스트 · 오늘의 지지선 터치</div>
        <div style="font-size:21px;margin-top:22px;opacity:.85">
          이 종목이 <b>실제로 지켜온 선</b>을 통계로 찾아드려요 — 무료</div>
        <div style="font-size:17px;margin-top:30px;opacity:.7">${esc(env.BRAND_NAME)} · ⚠ ${esc(env.DISCLAIMER)}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:20px;width:600px">
        <div class="card" style="border:none;box-shadow:0 14px 44px rgba(0,0,0,.22);padding:20px">
          <div style="font-size:21px;font-weight:800;margin-bottom:8px">${esc(DATA.radar.name)}
            <span class="small">일봉 · 추천 ${recs.slice(0, 2).map((r) => 'MA ' + r.period).join(' · ')}</span></div>
          <canvas id="w1" width="556" height="240"></canvas>
        </div>
        ${m ? `<div class="card" style="border:none;box-shadow:0 14px 44px rgba(0,0,0,.22);padding:20px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <div style="font-size:20px;font-weight:800">${esc(m.name)} <span class="small">${esc(m.symbol)}</span></div>
            <span style="background:${P.emeraldBg};color:${P.up};font-weight:800;font-size:17px;border-radius:9px;padding:3px 11px">MA ${m.period}</span>
          </div>
          <div class="meter" style="margin-bottom:8px"><i style="width:${Math.round(m.successRate * 100)}%"></i></div>
          <div class="small" style="font-size:16px">3년 지지 성공률 <b style="color:${P.text}">${fmt.fmtRate(m.successRate)}</b>
            · 지지 성공 ${m.supportBounces}회 (터치 ${m.touches}회)</div>
        </div>` : ''}
      </div>
    </div>
  `, `drawChart('w1', ${JSON.stringify(day.candles.slice(-90))}, ${JSON.stringify(lines)}, [],
      { up:'${P.up}', down:'${P.down}', grid:'${P.grid}', textColor:'${P.faint}',
        maxBars:90, fmtPrice: fmtHelpers.fmtPrice, fmtDate: fmtHelpers.fmtDate });`);
}

/* ---------- 렌더링 ---------- */

function findChromium() {
  if (process.env.CHROMIUM_PATH) return { executablePath: process.env.CHROMIUM_PATH };
  if (fs.existsSync('/opt/pw-browsers/chromium')) return { executablePath: '/opt/pw-browsers/chromium' };
  return { channel: 'chrome' }; // 맥 등: 설치된 크롬 사용
}

const SHOTS = [
  { name: 'portrait-1-radar', w: 636, h: 1048, html: screenRadar },
  { name: 'portrait-2-score', w: 636, h: 1048, html: screenScore },
  { name: 'portrait-3-screener', w: 636, h: 1048, html: screenScreener },
  { name: 'portrait-4-start', w: 636, h: 1048, html: screenStart },
  { name: 'landscape-1-hero', w: 1504, h: 741, html: screenWide },
];

const fontCss = ensureFonts();
fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch(findChromium());
const page1 = await browser.newPage();
// 페이지 안 스크립트 오류는 조용히 빈 차트가 되므로 반드시 표면화한다
page1.on('pageerror', (err) => {
  console.error(`페이지 오류: ${err.message}`);
  process.exitCode = 1;
});
for (const s of SHOTS) {
  await page1.setViewportSize({ width: s.w, height: s.h });
  await page1.setContent(s.html(fontCss), { waitUntil: 'load' });
  await page1.evaluate(() => document.fonts.ready);
  await page1.waitForTimeout(150);
  const file = path.join(OUT_DIR, `${s.name}.png`);
  await page1.screenshot({ path: file });
  console.log(`OK: ${file} (${s.w}x${s.h})`);
}
await browser.close();
if (DATA.provider === 'sample') {
  console.log('주의: data.json 이 sample(합성) 데이터입니다 — 제출 전 실데이터 환경에서 두 스크립트를 재실행하세요.');
}
