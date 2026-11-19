import type { PatternKey } from './api/types';
import type { AccentKey } from './theme';

// 차트 패턴 카탈로그 — 첫 화면(pages/patterns: 묶음 네 개)과 묶음 화면(pages/pattern-group)이
// 같이 쓴다. 키는 서버 app/patterns.py PATTERN_KEYS 와 같다.

export interface PatternInfo {
  key: PatternKey;
  label: string;
  emoji: string;
  plain: string;
  /** 카드 차트에 그릴 봉 수 — 없으면 화면 기본값 */
  bars?: number;
}

/**
 * 화면에 노출하는 패턴 — 서버(app/patterns.py PATTERN_KEYS)가 찾는 14가지 전부.
 * plain 은 생김새만 한 줄로 쓴다 — 앞으로의 방향은 말하지 않는다.
 * bars: 카드 차트에 그릴 봉 수(기본 CHART_BARS). 깃발형은 최근 40봉 안의 모양이라
 * 200봉에 그리면 오른쪽 끝에 점처럼 보여, 짧게 잘라 크게 그린다(보조선이 모두 그 안에 있다).
 */
export const PATTERNS: PatternInfo[] = [
  {
    key: 'downtrend_break',
    label: '하락 추세선 돌파',
    emoji: '📏',
    plain: '점점 낮아지던 고점들을 이은 선(하락 추세선) 위에서 종가가 처음 마감한 모양이에요.',
  },
  {
    key: 'uptrend_break',
    label: '상승 추세선 이탈',
    emoji: '✏️',
    plain: '점점 높아지던 저점들을 이은 선(상승 추세선) 아래에서 종가가 처음 마감한 모양이에요.',
  },
  {
    key: 'head_shoulders',
    label: '헤드앤숄더',
    emoji: '⛰️',
    plain: '봉우리 셋 중 가운데가 가장 높은 모양이에요. 머리와 두 어깨를 닮아 붙은 이름이에요.',
  },
  {
    key: 'inv_head_shoulders',
    label: '역헤드앤숄더',
    emoji: '🏞️',
    plain: '헤드앤숄더를 뒤집은 모양이에요. 골짜기 셋 중 가운데가 가장 깊어요.',
  },
  {
    key: 'double_top',
    label: '쌍봉',
    emoji: '🐫',
    plain: '비슷한 높이에서 고점을 두 번 만든 모양이에요. 낙타 등의 두 혹을 닮았어요.',
  },
  {
    key: 'double_bottom',
    label: '쌍바닥',
    emoji: '👓',
    plain: '비슷한 높이에서 저점을 두 번 만든 모양이에요. 알파벳 W를 닮았어요.',
  },
  {
    key: 'triple_top',
    label: '삼중천장',
    emoji: '🔱',
    plain: '비슷한 높이에서 고점을 세 번 만든 모양이에요.',
  },
  {
    key: 'triple_bottom',
    label: '삼중바닥',
    emoji: '🍡',
    plain: '비슷한 높이에서 저점을 세 번 만든 모양이에요.',
  },
  {
    key: 'triangle',
    label: '삼각수렴',
    emoji: '📐',
    plain: '위아래 두 선이 한 점으로 모이며 오르내리는 폭이 좁아지는 모양이에요. 한쪽 선이 수평일 수도 있어요.',
  },
  {
    key: 'wedge',
    label: '쐐기형',
    emoji: '🧀',
    plain: '위아래 두 선이 같은 쪽으로 기울면서 폭이 좁아지는 모양이에요.',
  },
  {
    key: 'rectangle',
    label: '박스권',
    emoji: '📦',
    plain: '거의 수평인 두 선 사이를 여러 번 오간 모양이에요.',
  },
  {
    key: 'flag',
    label: '깃발형',
    emoji: '🚩',
    plain: '짧은 기간 크게 움직인 구간(깃대) 뒤에, 좁은 폭 안에서 쉬어 가는 구간(깃발)이 붙은 모양이에요.',
    bars: 80,
  },
  {
    key: 'cup_handle',
    label: '컵앤핸들',
    emoji: '☕',
    plain: 'U자로 완만히 회복한 뒤, 살짝 눌러 쉬어가는 모양이에요.',
  },
  {
    key: 'stage2',
    label: '초기 상승추세',
    emoji: '📈',
    plain: '오래 옆으로 움직이던 주가가 장기 이동평균선 위로 올라선 모양이에요.',
  },
];

export type GroupKey = 'trend' | 'peaks' | 'lines' | 'other';

/**
 * 묶음 — 14개를 한 화면에 늘어놓으면 보기 불편하다(사용자 의견). 첫 화면에는 묶음 네 개만 두고,
 * 누르면 그 묶음의 패턴만 있는 화면으로 넘어간다.
 */
export const GROUPS: {
  key: GroupKey;
  title: string;
  emoji: string;
  accent: AccentKey;
  keys: PatternKey[];
}[] = [
  {
    key: 'trend',
    title: '추세선',
    emoji: '📏',
    accent: 'blue',
    keys: ['downtrend_break', 'uptrend_break'],
  },
  {
    key: 'peaks',
    title: '봉우리·골짜기',
    emoji: '⛰️',
    accent: 'green',
    keys: ['head_shoulders', 'inv_head_shoulders', 'double_top', 'double_bottom', 'triple_top', 'triple_bottom'],
  },
  {
    key: 'lines',
    title: '두 선 사이',
    emoji: '📐',
    accent: 'violet',
    keys: ['triangle', 'wedge', 'rectangle', 'flag'],
  },
  {
    key: 'other',
    title: '그 밖의 모양',
    emoji: '☕',
    accent: 'orange',
    keys: ['cup_handle', 'stage2'],
  },
];

export function patternInfo(key: PatternKey): PatternInfo {
  return PATTERNS.find((x) => x.key === key) ?? PATTERNS[0]!;
}

/** 화면 이동 값(params)에서 묶음을 읽는다 — 모르는 값이면 첫 묶음 */
export function toGroupKey(v: unknown): GroupKey {
  return GROUPS.some((g) => g.key === v) ? (v as GroupKey) : 'trend';
}

export function groupOf(key: GroupKey) {
  return GROUPS.find((g) => g.key === key) ?? GROUPS[0]!;
}
