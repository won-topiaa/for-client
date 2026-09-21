// 토스 앱(TDS, Toss Design System)의 시각 언어를 그대로 따르는 디자인 토큰.
//
// 왜 이렇게 바꿨나: 이 앱은 토스 안에서 열리는 미니앱이다. 토스 화면에서
// 우리 화면으로 넘어오는 순간 색·글자 크기·모서리·여백이 달라지면 사용자는
// "다른 앱으로 튕겼다"고 느낀다. 그래서 자체 팔레트(zinc + 에메랄드)를 버리고
// 토스의 회색 사다리 + 토스 블루로 맞춘다.
//
// 지킨 규칙 세 가지
//  1) 라이트 모드만. 앱인토스 TDS 는 다크 모드를 지원하지 않는다 —
//     미니앱은 라이트 기준으로 만들라는 것이 공식 가이드다.
//  2) 색은 회색 + 토스 블루가 기본. 빨강·파랑은 '시세'에만 쓴다.
//  3) 한국식 등락색: 빨강 = 상승/지지 성공, 파랑 = 하락/이탈.
//     토스를 포함한 국내 증권 앱의 관례이고, 여기서만 미국식(초록=상승)을
//     쓰면 같은 화면 안에서 색의 뜻이 뒤집힌다.

/* ── 토스 회색 사다리 ───────────────────────────────────────────── */
const GRAY = {
  50: '#F9FAFB',
  100: '#F2F4F6',
  200: '#E5E8EB',
  300: '#D1D6DB',
  400: '#B0B8C1',
  500: '#8B95A1',
  600: '#6B7684',
  700: '#4E5968',
  800: '#333D4B',
  900: '#191F28',
} as const;

/** 토스 블루 — 버튼·링크·선택 상태 등 '누를 수 있는 것'의 색 */
const BLUE = '#3182F6';
/** 상승·지지 성공 (국내 관례) */
const RED = '#F04452';
/** 하락·이탈 (국내 관례) */
const DOWN_BLUE = '#3182F6';

export interface Palette {
  /** 페이지 배경 — 카드(흰색)가 떠 보이도록 아주 옅은 회색 */
  bg: string;
  /** 카드·시트 */
  card: string;
  /** 입력창·진행바 바닥처럼 '눌러 들어간' 면 */
  sunken: string;
  /** 구분선. 카드 테두리로는 쓰지 않는다 — 토스 카드는 테두리가 없다. */
  border: string;
  text: string;
  sub: string;
  /** 3차 글자(캡션·보조 수치). 흰 바탕에서 4.5:1 을 넘는 선까지만 옅게 간다. */
  faint: string;
  /** 비활성 컨트롤과 장식(꺾쇠 등) 전용. **글자에 쓰지 않는다** — 옅은 바탕에서
   *  2:1 도 안 나와 읽히지 않는다. */
  disabled: string;
  grid: string;

  /** 주요 동작색 (토스 블루) */
  primary: string;
  primaryBg: string;
  /** 주요 동작색 위의 글자 */
  onPrimary: string;

  /** 상승 · 지지 성공 (빨강) */
  up: string;
  upBg: string;
  /** 하락 · 이탈 (파랑) */
  down: string;
  /** 오류 문구 — up 과 같은 빨강이지만 뜻이 달라 이름을 나눈다.
   *  (등락색을 언젠가 바꾸더라도 '실패'는 계속 빨강이어야 한다) */
  danger: string;

  /** 주의·별표 (주황) */
  warn: string;
  warnBg: string;
  /** 주의 상자 안의 글자. warn 을 그대로 글자에 쓰면 옅은 바탕에서 대비가 모자란다. */
  warnText: string;

  /** 차트 보조선 색 순서. 캔들(빨강/파랑)과 겹치지 않는 색만 쓴다. */
  ma: string[];
  events: { support: string; resistance: string; breakDown: string; breakUp: string };
}

// export 이유: 스토어 스크린샷 생성 스크립트(scripts/make_store_screenshots.mjs)가
// 이 팔레트를 그대로 import 해 쓴다 — 그림과 앱의 색이 어긋나지 않게.
export const LIGHT: Palette = {
  bg: GRAY[50],
  card: '#FFFFFF',
  sunken: GRAY[100],
  border: GRAY[200],
  text: GRAY[900],
  sub: GRAY[700],
  faint: GRAY[600],
  disabled: GRAY[400],
  grid: 'rgba(229,232,235,.9)',

  primary: BLUE,
  primaryBg: '#E8F3FF',
  onPrimary: '#FFFFFF',

  up: RED,
  upBg: '#FEECEE',
  down: DOWN_BLUE,
  danger: RED,

  warn: '#FF9500',
  warnBg: '#FFF4E5',
  warnText: '#8A5300',

  ma: ['#7C5CFC', '#FF9500', '#12B886', '#E64980', '#00A2B5'],
  events: { support: RED, resistance: DOWN_BLUE, breakDown: DOWN_BLUE, breakUp: RED },
};

/**
 * 기능마다 다른 아이콘 칩 색. 토스 '전체 메뉴'처럼 옅은 색 원 안에 아이콘을
 * 두는 방식이라, 카드에 굵은 테두리를 두르지 않고도 기능이 구분된다.
 */
export const ACCENT = {
  blue: { fg: BLUE, bg: '#E8F3FF' },
  red: { fg: RED, bg: '#FEECEE' },
  green: { fg: '#12B886', bg: '#E6F8F1' },
  orange: { fg: '#FF9500', bg: '#FFF4E5' },
  violet: { fg: '#7C5CFC', bg: '#F0EDFF' },
} as const;

export type AccentKey = keyof typeof ACCENT;

/** 모서리 — 토스는 카드가 크고 둥글다 */
export const RADIUS = {
  card: 16,
  button: 14,
  input: 14,
  chip: 999,
  badge: 8,
} as const;

/** 좌우 기본 여백. 토스 본문은 20pt 거터를 쓴다. */
export const GUTTER = 20;

/**
 * 등락 숫자의 색. 토스처럼 양수는 빨강, 음수는 파랑, 0 은 본문색.
 * (0 을 빨강으로 칠하면 안 오른 것도 오른 것처럼 읽힌다)
 */
export function signColor(v: number, p: Palette): string {
  if (!Number.isFinite(v) || v === 0) {
    return p.text;
  }
  return v > 0 ? p.up : p.down;
}

/**
 * 앱인토스 TDS 는 라이트 모드만 지원한다. 그래서 기기 설정이 다크여도
 * 같은 팔레트를 돌려준다 — 훅 모양은 유지해 호출부를 건드리지 않는다.
 */
export function usePalette(): Palette {
  return LIGHT;
}
