import { useColorScheme } from 'react-native';

// 사이트(주식 레이더) 공통 디자인 규약을 그대로 옮긴 팔레트:
// zinc 계열 배경/글자 + 에메랄드=상승/주요 · 빨강=하락 · 인디고=정보 · 앰버=이평선
export interface Palette {
  dark: boolean;
  bg: string;
  card: string;
  border: string;
  text: string;
  sub: string;
  faint: string;
  grid: string;
  up: string;
  down: string;
  indigo: string;
  amber: string;
  /** 추천 이평선 라인 색 순서 (웹 chartTheme().ma 와 동일) */
  ma: string[];
  events: { support: string; resistance: string; breakDown: string; breakUp: string };
  emeraldBg: string;
  warnBg: string;
}

// export 이유: 스토어 스크린샷 생성 스크립트(scripts/make_store_screenshots.mjs)가
// 이 팔레트를 그대로 import 해 쓴다 — 그림과 앱의 색이 어긋나지 않게.
export const LIGHT: Palette = {
  dark: false,
  bg: '#fafafa',
  card: '#ffffff',
  border: '#e4e4e7',
  text: '#18181b',
  sub: '#52525b',
  faint: '#71717a',
  grid: 'rgba(228,228,231,.8)',
  up: '#059669',
  down: '#dc2626',
  indigo: '#4f46e5',
  amber: '#d97706',
  ma: ['#4f46e5', '#d97706', '#0891b2', '#db2777', '#65a30d'],
  events: { support: '#059669', resistance: '#dc2626', breakDown: '#dc2626', breakUp: '#059669' },
  emeraldBg: 'rgba(5,150,105,.08)',
  warnBg: 'rgba(217,119,6,.1)',
};

export const DARK: Palette = {
  dark: true,
  bg: '#09090b',
  card: '#18181b',
  border: '#27272a',
  text: '#f4f4f5',
  sub: '#a1a1aa',
  faint: '#71717a',
  grid: 'rgba(39,39,42,.6)',
  up: '#34d399',
  down: '#f87171',
  indigo: '#818cf8',
  amber: '#fbbf24',
  ma: ['#818cf8', '#fbbf24', '#22d3ee', '#f472b6', '#a3e635'],
  events: { support: '#34d399', resistance: '#f87171', breakDown: '#f87171', breakUp: '#34d399' },
  emeraldBg: 'rgba(52,211,153,.12)',
  warnBg: 'rgba(251,191,36,.12)',
};

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? DARK : LIGHT;
}
