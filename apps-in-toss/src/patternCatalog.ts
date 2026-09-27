import type { PatternKey } from './api/types';
import type { AccentKey } from './theme';

// 차트 패턴 카탈로그 — 첫 화면(pages/patterns: 묶음 네 개)과 묶음 화면(pages/pattern-group)이
// 같이 쓴다. 키는 서버 app/patterns.py PATTERN_KEYS 와 같다.

export interface PatternInfo {
  key: PatternKey;
  label: string;
  emoji: string;
  plain: string;
  detail: string;
  /** 카드 차트에 그릴 봉 수 — 없으면 화면 기본값 */
  bars?: number;
}

const TAIL = ' 모양이 맞는지만 보고, 앞으로의 움직임은 말하지 않아요.';

/**
 * 화면에 노출하는 패턴 — 서버(app/patterns.py PATTERN_KEYS)가 찾는 14가지 전부.
 * 설명은 생김새와 탐지 기준(지난 사실)만 쓴다. 이름 속 '상승·하락·급등·급락'은
 * 선의 기울기나 지난 움직임이지 앞으로의 방향이 아니라는 점을 detail 에 밝힌다.
 * bars: 카드 차트에 그릴 봉 수(기본 CHART_BARS). 깃발형은 최근 40봉 안의 모양이라
 * 200봉에 그리면 오른쪽 끝에 점처럼 보여, 짧게 잘라 크게 그린다(보조선이 모두 그 안에 있다).
 */
export const PATTERNS: PatternInfo[] = [
  {
    key: 'downtrend_break',
    label: '하락 추세선 돌파',
    emoji: '📏',
    plain: '점점 낮아지던 고점들을 이은 선(하락 추세선) 위에서 종가가 처음 마감한 모양이에요.',
    detail:
      '최근 약 9개월 안에서 점점 낮아지는 고점들을 한 줄로 이은 선을 찾아요. 선에 3번 이상 ' +
      '닿았고, 두 달(40거래일) 넘게 종가가 한 번도 선 위에서 마감하지 않다가 최근 10거래일 ' +
      '이내에 처음 선 위에서 마감한 종목이에요. 지금 종가가 선과 5% 넘게 벌어져 있거나, 선 위 ' +
      '마감 뒤 선 아래로 2% 넘게 내려간 적이 있으면 목록에서 빠져요.' + TAIL,
  },
  {
    key: 'uptrend_break',
    label: '상승 추세선 이탈',
    emoji: '✏️',
    plain: '점점 높아지던 저점들을 이은 선(상승 추세선) 아래에서 종가가 처음 마감한 모양이에요.',
    detail:
      '하락 추세선 돌파를 뒤집은 모양이에요. 점점 높아지는 저점들을 이은 선에 3번 이상 닿았고, ' +
      '두 달(40거래일) 넘게 종가가 한 번도 선 아래에서 마감하지 않다가 최근 10거래일 이내에 ' +
      '처음 선 아래에서 마감한 종목이에요. 지금 종가가 선과 5% 넘게 벌어져 있거나, 선 아래 ' +
      '마감 뒤 선 위로 2% 넘게 올라간 적이 있으면 목록에서 빠져요.' + TAIL,
  },
  {
    key: 'head_shoulders',
    label: '헤드앤숄더',
    emoji: '⛰️',
    plain: '봉우리 셋 중 가운데가 가장 높은 모양이에요. 머리와 두 어깨를 닮아 붙은 이름이에요.',
    detail:
      '왼쪽 어깨 → 머리 → 오른쪽 어깨 순으로 고점 세 개가 만들어지고, 두 번의 ' +
      '되돌림 저점을 이은 선(넥라인)이 기준이 돼요.' + TAIL,
  },
  {
    key: 'inv_head_shoulders',
    label: '역헤드앤숄더',
    emoji: '🏞️',
    plain: '헤드앤숄더를 뒤집은 모양이에요. 골짜기 셋 중 가운데가 가장 깊어요.',
    detail:
      '왼쪽 어깨 → 머리 → 오른쪽 어깨 순으로 저점 세 개가 만들어지고, 가운데(머리)가 ' +
      '가장 깊어요. 되돌림 고점 둘을 이은 선(넥라인)이 기준이 돼요.' + TAIL,
  },
  {
    key: 'double_top',
    label: '쌍봉',
    emoji: '🐫',
    plain: '비슷한 높이에서 고점을 두 번 만든 모양이에요. 낙타 등의 두 혹을 닮았어요.',
    detail:
      '두 고점의 높이 차이가 3% 안이고, 두 고점 사이에서 가장 낮았던 가격(넥라인)보다 ' +
      '10% 넘게 높은 모양을 찾아요. 넥라인 근처에 있거나, 넥라인 아래에서 마감한 지 ' +
      '10거래일 이내인 종목만 보여 줘요.' + TAIL,
  },
  {
    key: 'double_bottom',
    label: '쌍바닥',
    emoji: '👓',
    plain: '비슷한 높이에서 저점을 두 번 만든 모양이에요. 알파벳 W를 닮았어요.',
    detail:
      '쌍봉을 뒤집은 모양이에요. 두 저점의 높이 차이가 3% 안이고, 두 저점 사이에서 가장 ' +
      '높았던 가격(넥라인)보다 10% 넘게 낮은 모양을 찾아요. 넥라인 근처에 있거나, 넥라인 ' +
      '위에서 마감한 지 10거래일 이내인 종목만 보여 줘요.' + TAIL,
  },
  {
    key: 'triple_top',
    label: '삼중천장',
    emoji: '🔱',
    plain: '비슷한 높이에서 고점을 세 번 만든 모양이에요.',
    detail:
      '세 고점의 높이 차이가 3% 안에 모인 모양이에요. 가운데가 두드러지게 높으면 ' +
      '헤드앤숄더로 따로 봐요. 고점 사이 두 저점 중 더 낮은 가격을 넥라인이라고 불러요. ' +
      '같은 고점 두 개가 쌍봉으로도 보이면 여기에서만 보여 줘요.' + TAIL,
  },
  {
    key: 'triple_bottom',
    label: '삼중바닥',
    emoji: '🍡',
    plain: '비슷한 높이에서 저점을 세 번 만든 모양이에요.',
    detail:
      '삼중천장을 뒤집은 모양이에요. 세 저점의 높이 차이가 3% 안에 모여 있고, 저점 사이 ' +
      '두 고점 중 더 높은 가격을 넥라인이라고 불러요. 같은 저점 두 개가 쌍바닥으로도 보이면 ' +
      '여기에서만 보여 줘요.' + TAIL,
  },
  {
    key: 'triangle',
    label: '삼각수렴',
    emoji: '📐',
    plain: '고점은 낮아지고 저점은 높아지며 변동폭이 점점 좁아지는 모양이에요.',
    detail:
      '위아래로 흔들리던 폭이 점점 줄어 한 점으로 모이는 구간이에요. 고점을 ' +
      '이은 선은 내려오고 저점을 이은 선은 올라가, 두 선 사이가 좁아지는 ' +
      '모양을 찾아요.',
  },
  {
    key: 'wedge',
    label: '쐐기형',
    emoji: '🧀',
    plain: '위아래 두 선이 같은 쪽으로 기울면서 폭이 좁아지는 모양이에요.',
    detail:
      '고점들을 따라 그은 선과 저점들을 따라 그은 선이 둘 다 오르거나(상승 쐐기) 둘 다 ' +
      '내리며(하락 쐐기) 가까워지는 모양이에요. 이름의 상승·하락은 두 선이 기운 방향이고, ' +
      '주가 방향을 말하는 이름이 아니에요.' + TAIL,
  },
  {
    key: 'rectangle',
    label: '박스권',
    emoji: '📦',
    plain: '거의 수평인 두 선 사이를 여러 번 오간 모양이에요.',
    detail:
      '위아래 두 선이 거의 수평이고, 한 달 넘게 그 사이에서 오르내린 종목을 찾아요. ' +
      '두 선 사이의 폭은 5~35%예요. 종가가 이미 선 밖으로 크게 나갔으면 빼요.' + TAIL,
  },
  {
    key: 'flag',
    label: '깃발형',
    emoji: '🚩',
    plain: '짧은 기간 크게 움직인 구간(깃대) 뒤에, 좁은 폭 안에서 쉬어 가는 구간(깃발)이 붙은 모양이에요.',
    detail:
      '3~20거래일 동안 15% 넘게 오르거나 내린 구간(깃대) 뒤에, 5~20거래일 동안 깃대의 절반보다 ' +
      '적게 되돌리며 좁은 폭 안에서 움직이는 모양을 찾아요. 위아래 두 선의 폭이 크게 변하지 ' +
      '않으면 깃발형, 위 선은 내려오고 아래 선은 올라와 모이면 페넌트형이에요. 목록에 붙는 ' +
      '‘크게 오른 뒤·크게 내린 뒤’는 이 모양 앞의 지난 움직임(깃대)이에요.' + TAIL,
    bars: 80,
  },
  {
    key: 'cup_handle',
    label: '컵앤핸들',
    emoji: '☕',
    plain: 'U자로 완만히 회복한 뒤, 살짝 눌러 쉬어가는 모양이에요.',
    detail:
      '깊게 빠졌다가 둥근 U자를 그리며 이전 고점 근처까지 돌아온 뒤(컵), ' +
      '짧고 얕게 내려온 구간(핸들)이 붙은 형태예요. 모양이 커피잔과 손잡이를 ' +
      '닮아 붙은 이름이에요.',
  },
  {
    key: 'stage2',
    label: '초기 상승추세',
    emoji: '📈',
    plain: '오래 옆으로 움직이던 주가가 장기 이동평균선 위로 올라선 모양이에요.',
    detail:
      '오래 옆으로 움직이던 구간(박스)의 위쪽 선을 최근 넘어섰고, 150일 이동평균선 ' +
      '위에 있으며, 그 이동평균선이 최근 위를 향하기 시작한 모양을 찾아요.' + TAIL,
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
  /** 묶음 화면 맨 위 한 줄 */
  desc: string;
  keys: PatternKey[];
}[] = [
  {
    key: 'trend',
    title: '추세선',
    emoji: '📏',
    accent: 'blue',
    desc: '고점이나 저점을 이은 선을 종가가 처음 넘어선 모양이에요.',
    keys: ['downtrend_break', 'uptrend_break'],
  },
  {
    key: 'peaks',
    title: '봉우리·골짜기',
    emoji: '⛰️',
    accent: 'green',
    desc: '비슷한 높이에서 고점이나 저점을 여러 번 만든 모양이에요.',
    keys: ['head_shoulders', 'inv_head_shoulders', 'double_top', 'double_bottom', 'triple_top', 'triple_bottom'],
  },
  {
    key: 'lines',
    title: '두 선 사이',
    emoji: '📐',
    accent: 'violet',
    desc: '위아래 두 선 사이에서 오르내리는 모양이에요.',
    keys: ['triangle', 'wedge', 'rectangle', 'flag'],
  },
  {
    key: 'other',
    title: '그 밖의 모양',
    emoji: '☕',
    accent: 'orange',
    desc: '둥근 바닥, 오랜 옆걸음 뒤처럼 따로 묶이지 않는 모양이에요.',
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
