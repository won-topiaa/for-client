import { Storage } from '@apps-in-toss/framework';
import { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';

// 토스 앱(TDS, Toss Design System)의 시각 언어를 따르는 디자인 토큰.
//
// 왜 이렇게 바꿨나: 이 앱은 토스 안에서 열리는 미니앱이다. 토스 화면에서
// 우리 화면으로 넘어오는 순간 색·글자 크기·모서리·여백이 달라지면 사용자는
// "다른 앱으로 튕겼다"고 느낀다. 그래서 자체 팔레트(zinc + 에메랄드)를 버리고
// 토스의 회색 사다리 + 토스 블루로 맞췄다.
//
// 다크 모드에 대해: 앱인토스 TDS 자체는 라이트만 지원한다고 안내한다. 그래도
// 두 벌을 들고 가는 이유는, 밤에 시세를 보는 사람이 흰 화면을 마주하는 쪽이
// 실제로 더 불편하기 때문이다. 기기 설정을 따르되 앱 안에서 직접 고를 수도
// 있게 해 둔다 — 호스트가 기기 설정을 넘겨주지 않아도 쓸 수 있어야 한다.
//
// 지킨 규칙
//  1) 색은 회색 + 토스 블루가 기본. 빨강·파랑은 '시세'에만 쓴다.
//  2) 한국식 등락색: 빨강 = 상승/지지 성공, 파랑 = 하락/이탈.
//  3) 글자 토큰은 제 바탕 위에서 4.5:1 을 넘긴다. 넘지 못하는 회색
//     (disabled·muted)은 글자가 아니라 '표시'에만 쓴다 — 이 규칙을 어겨서
//     면책 문구가 1.9:1 로 묻힌 적이 있다.

/* ── 토스 회색 사다리 (라이트) ──────────────────────────────────── */
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

export interface Palette {
  /** 다크 팔레트인가 — 그림자처럼 '밝기 방향'이 반대여야 하는 곳에서 쓴다. */
  dark: boolean;
  /** 페이지 배경 — 카드가 떠 보이도록 한 단계 낮은 면 */
  bg: string;
  /** 카드·시트 */
  card: string;
  /** 입력창·진행바 바닥처럼 '눌러 들어간' 면 */
  sunken: string;
  /** sunken 위에 떠 있는 조각(분절 선택기의 손잡이, 떠 있는 버튼).
   *  라이트에서는 흰색, 다크에서는 바탕보다 **밝은** 회색이다 — 다크에서
   *  더 어둡게 만들면 '눌러 들어간 것'처럼 보여 선택 상태가 뒤집혀 읽힌다. */
  raised: string;
  /** 구분선. 카드 테두리로는 쓰지 않는다 — 토스 카드는 테두리가 없다. */
  border: string;
  text: string;
  sub: string;
  /** 3차 글자(캡션·보조 수치). 제 바탕에서 4.4:1 을 넘는 선까지만 옅게 간다. */
  faint: string;
  /** 글자가 아닌 UI 표시(안 담은 별 같은 비선택 아이콘). 3:1 —
   *  '누를 수 있다'는 건 보이되 내용보다 앞서 나오지 않는 선. */
  muted: string;
  /** 비활성 컨트롤과 장식(꺾쇠 등) 전용. **글자에 쓰지 않는다.** */
  disabled: string;
  grid: string;

  /** 주요 동작색 — 글자·아이콘·선택 표시에 쓰는 파랑 */
  primary: string;
  /** 주요 버튼의 **면색**. 흰 글자를 얹어야 해서 primary 보다 한 단계 깊다.
   *  (다크에서 primary 를 그대로 면색에 쓰면 흰 글자가 3.1:1 로 떨어진다) */
  primaryFill: string;
  primaryBg: string;
  /** primaryFill 위의 글자 */
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
  /** 주의 상자 안의 글자. warn 을 그대로 글자에 쓰면 대비가 모자란다. */
  warnText: string;

  /** 차트 보조선 색 순서. 캔들(빨강/파랑)과 겹치지 않는 색만 쓴다. */
  ma: string[];
  events: { support: string; resistance: string; breakDown: string; breakUp: string };
}

// export 이유: 스토어 스크린샷 생성 스크립트(scripts/make_store_screenshots.mjs)가
// 이 팔레트를 그대로 import 해 쓴다 — 그림과 앱의 색이 어긋나지 않게.
export const LIGHT: Palette = {
  dark: false,
  bg: GRAY[50],
  card: '#FFFFFF',
  sunken: GRAY[100],
  raised: '#FFFFFF',
  border: GRAY[200],
  text: GRAY[900],
  sub: GRAY[700],
  faint: GRAY[600],
  muted: GRAY[500],
  disabled: GRAY[400],
  grid: 'rgba(229,232,235,.9)',

  primary: BLUE,
  primaryFill: BLUE,
  primaryBg: '#E8F3FF',
  onPrimary: '#FFFFFF',

  up: RED,
  upBg: '#FEECEE',
  down: BLUE,
  danger: RED,

  warn: '#FF9500',
  warnBg: '#FFF4E5',
  warnText: '#8A5300',

  ma: ['#7C5CFC', '#FF9500', '#12B886', '#E64980', '#00A2B5'],
  events: { support: RED, resistance: BLUE, breakDown: BLUE, breakUp: RED },
};

export const DARK: Palette = {
  dark: true,
  bg: '#141418',
  card: '#212227',
  sunken: '#2C2E35',
  raised: '#3E424B',
  border: '#383A41',
  text: '#F2F4F6',
  sub: '#C5CAD1',
  faint: '#9AA2AC',
  muted: '#7A828C',
  disabled: '#5A616B',
  grid: 'rgba(255,255,255,.08)',

  primary: '#4593F7',
  primaryFill: '#2F80ED',
  primaryBg: '#1C2A3E',
  onPrimary: '#FFFFFF',

  up: '#FF5D6B',
  upBg: '#3A2126',
  down: '#4593F7',
  danger: '#FF5D6B',

  warn: '#FFA33F',
  warnBg: '#3A2E1B',
  warnText: '#FFC978',

  // 어두운 바탕에서는 라이트용 보조선 색이 가라앉는다 — 한 단계씩 밝힌다
  ma: ['#A48BFF', '#FFA33F', '#2FD49A', '#FF7AB6', '#3FC8DB'],
  events: { support: '#FF5D6B', resistance: '#4593F7', breakDown: '#4593F7', breakUp: '#FF5D6B' },
};

/**
 * 기능마다 다른 아이콘 칩 바탕. 토스 '전체 메뉴'처럼 옅은 색 원 안에 아이콘을
 * 두는 방식이라, 카드에 굵은 테두리를 두르지 않고도 기능이 구분된다.
 */
const ACCENT_BG = {
  light: {
    blue: '#E8F3FF',
    red: '#FEECEE',
    green: '#E6F8F1',
    orange: '#FFF4E5',
    violet: '#F0EDFF',
  },
  dark: {
    blue: '#1C2A3E',
    red: '#3A2126',
    green: '#14322A',
    orange: '#3A2E1B',
    violet: '#272042',
  },
} as const;

export type AccentKey = keyof (typeof ACCENT_BG)['light'];

/** 아이콘 칩 바탕색 — 팔레트에 맞는 쪽을 고른다. */
export function accentBg(p: Palette, key: AccentKey): string {
  return ACCENT_BG[p.dark ? 'dark' : 'light'][key];
}

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

/* ── 화면 테마 설정 ─────────────────────────────────────────────── */

/** 'auto' 는 휴대폰 설정을 따른다. */
export type ThemeMode = 'auto' | 'light' | 'dark';

const MODE_KEY = 'wontopia.theme';

// 모듈 캐시 + 구독. 관심종목(watchlist.ts)과 같은 방식이다 — 여러 화면이
// 같은 값을 보고, 한 화면에서 바꾸면 나머지도 즉시 따라 바뀐다.
let themeMode: ThemeMode = 'auto';
/** 이번 실행에서 사용자가 직접 골랐는가. 읽는 도중에 고른 경우, 늦게 도착한
 *  저장값이 그 선택을 덮어쓰지 않게 하는 표시다. */
let userChose = false;
/** 진행 중이거나 끝난 읽기. 성공하면 그대로 남아 두 번 읽지 않는다. */
let modeLoad: Promise<void> | null = null;
const modeListeners = new Set<(m: ThemeMode) => void>();

function isMode(v: unknown): v is ThemeMode {
  return v === 'auto' || v === 'light' || v === 'dark';
}

function emitMode(m: ThemeMode): void {
  for (const fn of modeListeners) {
    fn(m);
  }
}

/**
 * 저장된 설정을 읽는다. 실패하면 '자동'으로 둔다 — 테마는 못 읽었다고 화면을
 * 막을 이유가 없는 값이다.
 *
 * 실패를 '읽었다'로 캐시하지 않는다(modeLoad 를 비운다). 한 번의 일시적
 * 실패로 그 실행 내내 저장해 둔 설정을 못 읽게 되면, 다크를 골라 둔 사람이
 * 앱을 켤 때마다 라이트를 보게 된다. (watchlist.ts 가 같은 이유로 실패를
 * 캐시하지 않는다.)
 *
 * Storage 가 비동기라, '다크'를 골라 둔 사람은 앱을 열 때 아주 잠깐 라이트를
 * 본 뒤 바뀐다. 동기로 읽을 방법이 없어 남겨 두는 한계다 — 읽기는 앱이 뜨는
 * 즉시(_app.tsx 의 usePalette) 시작하므로 한 프레임 수준이다.
 */
function loadThemeMode(): Promise<void> {
  if (!modeLoad) {
    modeLoad = (async () => {
      let raw: string | null = null;
      try {
        raw = await Storage.getItem(MODE_KEY);
      } catch {
        modeLoad = null; // 다음 화면이 다시 시도할 수 있게
        return;
      }
      // 읽는 사이에 사용자가 직접 골랐다면 그쪽이 이긴다. 안 그러면 방금 누른
      // 선택이 저장소의 옛 값으로 되돌아가고(화면만), 저장된 값과도 어긋난다.
      if (userChose || !isMode(raw) || raw === themeMode) {
        return;
      }
      themeMode = raw;
      emitMode(raw);
    })();
  }
  return modeLoad;
}

// 저장만 한 줄로 세운다. 화면 갱신은 동기라 유실될 일이 없고, Storage 쓰기만
// 순서가 뒤집히면 나중에 누른 값이 먼저 기록돼 화면과 저장값이 어긋난다.
let modeWriteQueue: Promise<unknown> = Promise.resolve();

/** 테마를 바꾸고 저장한다. 저장 실패는 조용히 넘긴다(이번 실행에는 적용된다). */
export function setThemeMode(mode: ThemeMode): void {
  userChose = true;
  if (themeMode === mode) {
    return;
  }
  themeMode = mode;
  // 화면을 먼저 바꾸고 저장은 뒤따르게 — 저장이 늦거나 실패해도 누른 즉시 바뀐다
  emitMode(mode);
  modeWriteQueue = modeWriteQueue
    .then(() => Storage.setItem(MODE_KEY, mode))
    .catch(() => undefined); // 실패해도 큐가 막히지 않게
}

/** 지금 고른 테마 설정(자동/라이트/다크)과 바꾸는 함수. */
export function useThemeMode(): { mode: ThemeMode; setMode: (m: ThemeMode) => void } {
  const [mode, setLocal] = useState<ThemeMode>(themeMode);
  useEffect(() => {
    modeListeners.add(setLocal);
    // 구독을 붙이기 전에 읽기가 끝나 있을 수 있다 — 그러면 알림을 못 받고
    // 이 화면만 '자동'에 머문다. 끝난 뒤 현재 값으로 한 번 맞춘다.
    void loadThemeMode().then(() => setLocal(themeMode));
    return () => {
      modeListeners.delete(setLocal);
    };
  }, []);
  return { mode, setMode: setThemeMode };
}

/**
 * 화면이 쓸 팔레트.
 *
 * useColorScheme 은 호스트가 기기 설정을 넘겨주지 않으면 null 을 준다. 그래서
 * 'dark' 인지만 보고, 아니면 라이트로 떨어뜨린다 — 넘겨주지 않는 환경에서도
 * 사용자가 직접 '다크'를 고르면 그대로 적용된다.
 */
export function usePalette(): Palette {
  const device = useColorScheme();
  const { mode } = useThemeMode();
  const dark = mode === 'dark' || (mode === 'auto' && device === 'dark');
  return dark ? DARK : LIGHT;
}
