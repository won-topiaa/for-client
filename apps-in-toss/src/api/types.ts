// 서버(app/service.py · touch_scan.py · server.py) 직렬화 형태와 1:1 대응

export interface SymbolInfo {
  symbol: string;
  name: string;
  market?: string | null;
}

export interface SearchResponse {
  provider: string;
  results: SymbolInfo[];
}

export interface Candle {
  time: string; // "YYYY-MM-DD"
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface TimeValue {
  time: string;
  value: number;
}

export type Timeframe = 'day' | 'week' | 'month';

export interface MAEvent {
  time: string;
  side: 'support' | 'resistance';
  outcome: 'bounce' | 'break' | 'undecided';
  period: number;
}

// 주의: 서버는 '지지 전용' 과 '양방향(저항 포함)' 을 이름으로 구분한다.
// 화면에 '지지 성공률' 로 보여줄 대표 수치는 supportRate·supportScore 다.
// successRate·score 는 저항까지 포함한 참고값이라 라벨과 뜻이 다르다.
export interface MAStat {
  period: number;
  touches: number;
  supportBounces: number;
  resistanceBounces: number;
  bounces: number;
  breaks: number;
  undecided: number;
  /** 지지 전용 가중 성공률 0~1 — 화면 대표 수치 */
  supportRate: number;
  /** 지지 판정 시도 횟수(지지 성공률의 모수) */
  supportTests: number;
  /** 지지 전용 점수 — 서버의 ★추천 선정 기준 */
  supportScore: number;
  /** 저항까지 포함한 양방향 가중 성공률 0~1 — 참고값 */
  successRate: number;
  wilsonLb: number;
  /** 양방향 점수 — 참고값 */
  score: number;
  qualified: boolean;
  insufficientData: boolean;
  lastTouch: string | null;
}

export interface RecommendedMA extends MAStat {
  ma: TimeValue[];
  events: MAEvent[];
}

export interface TimeframeReport {
  timeframe: string;
  error?: string;
  bars?: number;
  windowStart?: string | null;
  windowEnd?: string | null;
  halfLifeBars?: number;
  candles?: Candle[];
  recommended?: RecommendedMA[];
  stats?: MAStat[];
  lookbackYears?: number | null;
}

export interface AnalyzeResponse {
  symbol: string;
  provider: string;
  timeframes: Partial<Record<Timeframe, TimeframeReport>>;
}

export type Market = 'kr' | 'us';

export interface TouchMatch {
  symbol: string;
  name: string;
  market?: string | null;
  period: number;
  /** 지지 전용 성공률 0~1 — 화면 대표 수치 (서버가 successRate 에서 이름을 바꿨다) */
  supportRate: number;
  /** 지지 판정 시도 횟수(지지 성공률의 모수) */
  supportTests: number;
  /** 저항까지 포함한 양방향 성공률 0~1 — 참고값 */
  bothSidesRate: number;
  touches: number;
  supportBounces: number;
  maScore: number;
  distPct: number;
  maValue: number;
  close: number;
  candles: Candle[];
  maLine: TimeValue[];
}

export interface TouchesResponse {
  status: 'running' | 'done' | 'error';
  detail?: string;
  // running 일 때
  done?: number;
  total?: number;
  // done 일 때
  market?: string;
  scanned?: number;
  universe?: number;
  elapsedSec?: number;
  refreshing?: boolean;
  partial?: boolean;
  generatedAt?: string | number;
  matches?: TouchMatch[];
  totalMatches?: number;
}

/* ---------- 아침 브리핑 한 장 ---------- */

/** 한 시장의 오늘 스캔 요약. total 이 null 이면 아직 계산 중이라는 뜻 —
 *  0 과 구별해야 한다 (0 은 '오늘 한 건도 없음'). */
export interface TodaySupport {
  status: 'running' | 'done' | 'error';
  total: number | null;
  partial: boolean;
}

export interface TodayResponse {
  /** 기준일 (MM/DD). */
  asOf?: string | null;
  /** 지수 기준일이 서로 다른 날(미국 종가와 국내 종가가 갈린 날). */
  asOfMixed?: boolean;
  /** 지수·공포탐욕을 이어 붙인 한 줄. */
  line?: string;
  /** 한글 라벨 → 표시용 값 ("26,333 ▲0.96%"). */
  vars?: Record<string, string>;
  /** 오늘 값을 받지 못해 빠진 항목. */
  missing?: string[];
  support?: Record<string, TodaySupport>;
  /** 스캔 결과가 새로 계산되는 시각 "HH:MM" (KST). 서버가 알려준다 —
   *  앱이 적어 두면 서버 설정이 바뀔 때 조용히 어긋난다. */
  refreshAtKst?: string;
}

/* ---------- 맞춤 이평선 (내가 고른 N일선) ---------- */

/** 지지를 받는 중인가, 저항에 막혀 있는가. */
export type LineSide = 'support' | 'resistance';

export interface LineMatch {
  symbol: string;
  name: string;
  market?: string | null;
  side: LineSide;
  period: number;
  /** 그 선이 해당 방향에서 지켜진 비율 0~1 (최근 가중). 화면 대표 수치. */
  respectRate: number;
  /** 그 방향에서 결판난(반등/이탈) 에피소드 수 — respectRate 의 모수. */
  decided: number;
  /** 양방향 터치 총합 — 참고값. respectRate 의 모수가 아니다. */
  touches: number;
  maScore: number;
  distPct: number;
  /** 이평선 자체의 기울기 %(10봉 기준). 하락하는 선의 지지는 신뢰가 낮다. */
  slopePct: number;
  maValue: number;
  close: number;
  candles: Candle[];
  maLine: TimeValue[];
}

export interface LinesResponse {
  status: 'running' | 'done' | 'error';
  detail?: string;
  // running 일 때
  done?: number;
  total?: number;
  // done 일 때
  market?: string;
  period?: number;
  scanned?: number;
  universe?: number;
  elapsedSec?: number;
  refreshing?: boolean;
  partial?: boolean;
  generatedAt?: string | number;
  /** 직전에 받은 결과와 같으면 서버가 목록 없이 이 값만 준다(대역폭 절약). */
  unchanged?: boolean;
  support?: LineMatch[];
  resistance?: LineMatch[];
  totalSupport?: number;
  totalResistance?: number;
}

/* ---------- 차트 패턴 스크리너 ---------- */

// 서버(/api/patterns)가 받는 패턴 키. 앱 화면에는 이 중 셋만 노출하지만,
// 타입은 서버가 주는 값 전부를 인정한다 — 나중에 노출을 늘릴 때 타입을
// 건드리지 않아도 되고, 서버가 다른 키를 돌려줘도 타입이 거짓말하지 않는다.
export type PatternKey =
  | 'stage2'
  | 'triangle'
  | 'head_shoulders'
  | 'inv_head_shoulders'
  | 'cup_handle';

/** 차트에 겹쳐 그리는 보조선 (넥라인·추세선·컵 테두리 등). */
export interface PatternOverlay {
  /** 사람이 읽는 이름 — 범례에 쓴다 ("넥라인", "지지선" …). */
  name: string;
  points: TimeValue[];
}

export interface PatternMatch {
  symbol: string;
  name: string;
  market?: string | null;
  /** 패턴 적합도 점수 (서버 정렬 기준). */
  score: number;
  /** 왜 이 패턴으로 봤는지 — 서버가 만든 한 줄 설명. */
  summary: string;
  summaryEn?: string;
  candles: Candle[];
  overlays: PatternOverlay[];
}

export interface PatternsResponse {
  status: 'running' | 'done' | 'error';
  detail?: string;
  // running 일 때
  done?: number;
  total?: number;
  // done 일 때
  pattern?: string;
  market?: string;
  scanned?: number;
  universe?: number;
  elapsedSec?: number;
  refreshing?: boolean;
  partial?: boolean;
  generatedAt?: string | number;
  matches?: PatternMatch[];
  totalMatches?: number;
}
