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
  return new Set([...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]));
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

/** 서버에만 있는 키는 경고, 앱 타입에만 있는 키는 오류(= 화면에 undefined 가 뜬다) */
function compare(label, declared, actual, { optional = [] } = {}) {
  const server = new Set(Object.keys(actual));
  const missing = [...declared].filter((f) => !server.has(f) && !optional.includes(f));
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

// ---- /api/touches ----
const touches = await get('/api/touches?market=kr');
if (touches.status !== 'done') {
  console.log(`  ⚠ /api/touches: status=${touches.status} — 스캔 중이라 매치를 대조하지 못했습니다.`);
  console.log('    잠시 뒤 다시 실행해 주세요 (스캔이 끝나야 matches 가 채워집니다).');
} else {
  const m = (touches.matches ?? [])[0];
  if (!m) {
    console.log('  ⚠ /api/touches: 오늘 매치가 0건이라 대조하지 못했습니다.');
  } else {
    ok = compare('TouchMatch (/api/touches)', declaredFields('TouchMatch'), m, {
      optional: ['market'],
    }) && ok;
  }
}

console.log();
if (!ok) {
  console.error('계약 불일치 — 이대로 번들을 올리면 화면에 NaN/undefined 가 뜹니다.');
  process.exit(1);
}
console.log('계약 일치 — 번들을 만들어도 좋습니다.');
