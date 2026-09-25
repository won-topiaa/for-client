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

/* ---------- 차트 사진 분석 (종합 진단) ---------- */

// 서버 app/diagnosis.py · app/photo.py 의 응답. 숫자·판정은 전부 서버 엔진이
// 그 종목의 최신 데이터로 계산한 것이고, 사진에서 읽은 숫자는 없다.

/** 사실 한 줄 — area 는 '지지선'·'추세'·'모멘텀'·'변동성'·'거래량'·'차트 모양'. */
export interface DiagnosisSentence {
  area: string;
  label: string;
  text: string;
}

/** 감지된 차트 모양 하나 (감지된 것만 온다). */
export interface DiagnosisPattern {
  key: string;
  name: string;
  facts: string[];
  summary: string;
  overlays: PatternOverlay[];
}

export interface DiagnosisTimeframe {
  sentences: DiagnosisSentence[];
}

export interface Diagnosis {
  asOf: string;
  patterns: DiagnosisPattern[];
  timeframes: Partial<Record<Timeframe, DiagnosisTimeframe>>;
  notice: string;
}

export interface PhotoExplanationPoint {
  area: string;
  text: string;
}

/**
 * 설명 — AI(저가 비전 모델)가 쓴 것이거나, AI 를 못 쓸 때 서버가 사실 문장으로
 * 만든 템플릿. by 가 'template' 이면 reason 에 이유가 온다.
 */
export interface PhotoExplanation {
  by: string;
  reason: 'no_key' | 'budget' | 'error' | 'filtered' | null;
  isChart: boolean | null;
  sameStock: 'yes' | 'no' | 'unclear';
  timeframe: 'day' | 'week' | 'month' | 'intraday' | 'unclear';
  photoNote: string;
  summary: string;
  points: PhotoExplanationPoint[];
}

export interface PhotoAnalysisResponse {
  symbol: string;
  name: string;
  asOf: string;
  explanation: PhotoExplanation;
  diagnosis: Diagnosis;
  notice: string;
}
