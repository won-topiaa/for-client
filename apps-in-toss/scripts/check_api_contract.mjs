#!/usr/bin/env node
// 앱의 타입 선언(src/api/types.ts)과 **실제 배포 서버의 응답**을 대조한다.
//
// 왜 필요한가: 서버 저장소(won-topiaa/ma-radar)와 앱 저장소가 갈라져 있어,
// 서버가 필드 이름을 바꿔도 앱 쪽에서는 아무것도 깨지지 않는다. api/client.ts 가
// 응답을 `body as T` 로 무검증 캐스팅하므로 타입체커도 못 잡는다. 실제로
// `successRate` → `supportRate` 변경을 놓쳐 '오늘의 지지선' 카드의 성공률이
// 전부 NaN% 로 뜬 채 제출 직전까지 갔다.
//
// 사용: node scripts/check_api_contract.mjs
// 번들(.ait)을 만들어 콘솔에 올리기 전에 반드시 한 번 돌린다.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = readFileSync(join(ROOT, 'src/api/types.ts'), 'utf8');
const ENV = readFileSync(join(ROOT, 'src/env.ts'), 'utf8');

const BASE = /API_BASE_URL\s*=\s*['"]([^'"]+)['"]/.exec(ENV)?.[1];
if (!BASE) {
  console.error('src/env.ts 에서 API_BASE_URL 을 찾지 못했습니다.');
  process.exit(2);
}

/** types.ts 의 `interface X { ... }` 블록에서 선언된 필드 이름을 뽑는다. */
function declaredFields(name) {
  const start = TYPES.indexOf(`interface ${name} `);
  if (start < 0) throw new Error(`types.ts 에 interface ${name} 가 없습니다.`);
  const body = TYPES.slice(start, TYPES.indexOf('\n}', start));
  // 들여쓰기 2칸의 `field?: type` 만 — 주석과 중첩 블록은 걸리지 않는다
  const fields = new Set([...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]));
  // 파싱이 빈 집합을 내면 이후 비교가 전부 공허하게 '통과'한다(fails open).
  // 포맷이 바뀌어 정규식이 안 먹은 것이므로 조용히 넘기지 않고 멈춘다.
  if (fields.size === 0) {
    throw new Error(
      `interface ${name} 에서 필드를 하나도 뽑지 못했습니다 — types.ts 포맷이 바뀌었는지 ` +
        `확인하세요(이 스크립트의 정규식은 들여쓰기 2칸을 전제합니다).`
    );
  }
  return fields;
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

// 타입에는 선언돼 있지만 화면이 실제로 읽지는 않는 '참고용' 필드들.
// 서버가 이것들을 정리해도 화면은 멀쩡하므로, 없다고 릴리스를 막지 않는다.
// (게이트가 잡아야 할 것은 '화면이 읽는데 서버가 안 주는' 필드뿐이다.)
const REFERENCE_ONLY = ['bounces', 'successRate', 'wilsonLb', 'score', 'bothSidesRate'];

/** 서버에만 있는 키는 경고, 앱 타입에만 있는 키는 오류(= 화면에 undefined 가 뜬다) */
function compare(label, declared, actual, { optional = [] } = {}) {
  const skip = new Set([...optional, ...REFERENCE_ONLY]);
  const server = new Set(Object.keys(actual));
  const missing = [...declared].filter((f) => !server.has(f) && !skip.has(f));
  const extra = [...server].filter((f) => !declared.has(f));
  if (extra.length) {
    console.log(`  ℹ ${label}: 서버에만 있는 키 (앱이 안 씀) — ${extra.join(', ')}`);
  }
  if (missing.length) {
    console.error(`  ✗ ${label}: 앱이 기대하는데 서버가 안 주는 키 — ${missing.join(', ')}`);
    return false;
  }
  console.log(`  ✓ ${label}: 앱이 쓰는 키가 모두 존재`);
  return true;
}

let ok = true;
console.log(`대상 서버: ${BASE}\n`);

// ---- /api/search ----
const search = await get('/api/search?q=' + encodeURIComponent('삼성'));
const first = (search.results ?? [])[0];
if (!first) {
  console.error('  ✗ /api/search: 결과가 비어 대조할 수 없습니다.');
  ok = false;
} else {
  ok = compare('SymbolInfo (/api/search)', declaredFields('SymbolInfo'), first, {
    optional: ['market'],
  }) && ok;
}

// ---- /api/analyze ----
const analyze = await get('/api/analyze?symbol=005930');
const day = analyze.timeframes?.day ?? {};
const rec = (day.recommended ?? [])[0];
const stat = (day.stats ?? [])[0];
if (!rec || !stat) {
  console.error('  ✗ /api/analyze: recommended/stats 가 비어 대조할 수 없습니다.');
  ok = false;
} else {
  // RecommendedMA 는 MAStat 을 확장한다 — 두 선언을 합쳐서 본다
  const recFields = new Set([...declaredFields('MAStat'), ...declaredFields('RecommendedMA')]);
  ok = compare('MAStat (/api/analyze stats)', declaredFields('MAStat'), stat) && ok;
  ok = compare('RecommendedMA (/api/analyze recommended)', recFields, rec) && ok;
}

// ---- /api/analyze diagnosis (차트 사진 분석과 같은 진단 블록) ----
// /api/photo-analysis 는 사진을 보내야 해서(하루 횟수·AI 호출이 든다) 여기서
// 부르지 않는다. 대신 그 응답의 diagnosis 와 똑같은 블록이 /api/analyze 에도
// 실려 오므로, 화면이 읽는 진단 키는 여기서 대조한다.
const diag = analyze.diagnosis;
if (!diag) {
  console.error('  ✗ Diagnosis: /api/analyze 응답에 diagnosis 가 없습니다 (서버가 1.3.5 이전 버전?).');
  ok = false;
} else {
  ok = compare('Diagnosis (/api/analyze diagnosis)', declaredFields('Diagnosis'), diag) && ok;
  const sent = (diag.timeframes?.day?.sentences ?? [])[0];
  if (!sent) {
    console.error('  ✗ DiagnosisSentence: 일봉 문장이 비어 대조할 수 없습니다.');
    ok = false;
  } else {
    ok = compare('DiagnosisSentence', declaredFields('DiagnosisSentence'), sent) && ok;
  }
  const pat = (diag.patterns ?? [])[0];
  if (pat) {
    ok = compare('DiagnosisPattern', declaredFields('DiagnosisPattern'), pat) && ok;
  } else {
    console.log('  … DiagnosisPattern: 005930 에 지금 감지된 차트 모양이 없어 건너뜀');
  }
}

// ---- /api/touches ----
// TouchMatch 는 이름이 바뀌어 사고가 났던 바로 그 인터페이스다. 대조를 못 했으면
// '통과'로 넘기지 않는다 — 스캔이 도는 중이거나 매치가 0건이면 잠시 뒤 다시
// 실행해야 한다. 검사하지 못한 것을 합격으로 처리하면 이 게이트는 무의미해진다.
let touchesChecked = false;
for (const market of ['kr', 'us']) {
  const touches = await get(`/api/touches?market=${market}`);
  if (touches.status !== 'done') {
    console.log(`  … /api/touches?market=${market}: status=${touches.status} — 스캔 중`);
    continue;
  }
  const m = (touches.matches ?? [])[0];
  if (!m) {
    console.log(`  … /api/touches?market=${market}: 오늘 매치 0건`);
    continue;
  }
  ok = compare(`TouchMatch (/api/touches?market=${market})`, declaredFields('TouchMatch'), m, {
    optional: ['market'],
  }) && ok;
  touchesChecked = true;
}
if (!touchesChecked) {
  console.error('  ✗ TouchMatch: 두 시장 모두 대조하지 못했습니다 (스캔 중이거나 매치 0건).');
  console.error('    스캔이 끝난 뒤 다시 실행해 주세요 — 확인하지 못한 것을 통과로 두지 않습니다.');
  ok = false;
}

// ---- /api/today (아침 브리핑) ----
// 홈 최상단 카드가 쓰는 응답. 알림을 누른 사람이 처음 보는 자리라, 여기서
// 키가 어긋나면 '오늘의 시장'이 통째로 빈칸이 된다.
{
  const today = await get('/api/today');
  // 일곱 키를 모두 요구한다. 서버는 값이 없는 날에도 키는 넣어 주므로(asOf 는
  // null) 이것이 정확한 기대치이고, 키가 사라지면 카드에서 그 줄이 조용히
  // 빠지는 것을 여기서 잡는다.
  ok = compare('TodayResponse (/api/today)', declaredFields('TodayResponse'), today) && ok;
  const side = (today.support ?? {}).kr;
  if (side) {
    ok = compare('TodaySupport (/api/today support.kr)', declaredFields('TodaySupport'), side) && ok;
  } else {
    console.error('  ✗ TodaySupport: support.kr 이 없습니다.');
    ok = false;
  }
}

// ---- /api/lines (맞춤 이평선) ----
// TouchMatch 와 같은 이유로 '확인 못 함'을 통과로 두지 않는다. 다만 이쪽은
// (시장, 기간) 조합마다 스캐너가 따로라, 그날 처음 묻는 조합이면 1~2분 걸린다.
// 화면이 쓰는 기본값(kr/us × 20일)만 대조한다 — 나머지 기간도 같은 코드가
// 같은 모양으로 만든다.
let linesChecked = false;
for (const market of ['kr', 'us']) {
  const lines = await get(`/api/lines?market=${market}&period=20`);
  if (lines.status !== 'done') {
    console.log(`  … /api/lines?market=${market}: status=${lines.status} — 스캔 중`);
    continue;
  }
  // 지지·저항 어느 쪽이든 한 건이면 필드 모양을 확인할 수 있다
  const m = (lines.support ?? [])[0] ?? (lines.resistance ?? [])[0];
  if (!m) {
    console.log(`  … /api/lines?market=${market}: 오늘 매치 0건`);
    continue;
  }
  ok = compare(`LineMatch (/api/lines?market=${market})`, declaredFields('LineMatch'), m, {
    optional: ['market'],
  }) && ok;
  linesChecked = true;
}
if (!linesChecked) {
  console.error('  ✗ LineMatch: 두 시장 모두 대조하지 못했습니다 (스캔 중이거나 매치 0건).');
  console.error('    처음 묻는 (시장, 기간) 조합은 서버가 1~2분 훑습니다 — 잠시 뒤 다시 실행해 주세요.');
  ok = false;
}

console.log();
if (!ok) {
  console.error('계약 불일치 — 이대로 번들을 올리면 화면에 NaN/undefined 가 뜹니다.');
  process.exit(1);
}
console.log('계약 일치 — 번들을 만들어도 좋습니다.');
