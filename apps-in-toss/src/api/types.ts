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
