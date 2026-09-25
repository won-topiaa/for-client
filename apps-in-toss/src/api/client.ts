import { API_BASE_URL } from '../env';
import { learnRefreshAt } from '../refreshDay';
import type {
  AnalyzeResponse,
  LinesResponse,
  TodayResponse,
  Market,
  PatternKey,
  PatternsResponse,
  PhotoAnalysisResponse,
  SearchResponse,
  TouchesResponse,
} from './types';

// 앱인토스 정책상 미니앱은 토스 로그인 외의 자체 로그인을 제공할 수 없다.
// 그래서 앱은 계정 없이 동작한다 — 모든 조회는 인증 없는 공개 API 를 쓴다.
// (사이트는 그대로 이메일 회원제를 유지한다. 서버의 /touches 페이지 참고.)

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 429 일 때 서버가 알려준 대기 시간(초). 화면이 그만큼 물러섰다 재시도한다. */
    readonly retryAfterSec?: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 레이트리밋에 걸렸나 — 일시적이라 실패로 처리하지 않고 물러섰다 다시 시도한다. */
export function isRateLimited(err: unknown): boolean {
  return err instanceof ApiError && err.status === 429;
}

/** FastAPI 의 detail 은 문자열 또는 검증오류 객체 배열 — 사람이 읽을 문장으로 */
function detailMessage(detail: unknown, status: number): string {
  if (typeof detail === 'string') {
    return detail;
  }
  if (Array.isArray(detail)) {
    const msgs = detail
      .map((x) => (x && typeof x === 'object' && 'msg' in x ? String((x as { msg: unknown }).msg) : String(x)))
      .join(', ');
    if (msgs) {
      return msgs;
    }
  }
  return `HTTP ${status}`;
}

/** 요청별 제한 시간(ms). 서버가 잠들어 있으면 깨우는 데만 1분 가까이 걸린다. */
// 사진 분석은 종목 분석(잠든 서버면 최대 1분) 뒤에 AI 설명(최대 30초)이 이어진다.
const TIMEOUT_MS = { search: 15000, analyze: 60000, photo: 95000, touches: 30000, default: 30000 };

function timeoutFor(path: string): number {
  if (path.startsWith('/api/search')) return TIMEOUT_MS.search;
  if (path.startsWith('/api/analyze')) return TIMEOUT_MS.analyze;
  if (path.startsWith('/api/photo-analysis')) return TIMEOUT_MS.photo;
  if (path.startsWith('/api/touches')) return TIMEOUT_MS.touches;
  return TIMEOUT_MS.default;
}

/** fetch 한 번의 결과 — 응답을 받았거나, 제한 시간을 넘겼거나, 연결 자체가 실패. */
type Attempt =
  | { kind: 'ok'; res: Response }
  | { kind: 'timeout' }
  | { kind: 'offline' };

/** 본문을 보내는 요청(POST)의 재료. 없으면 GET. */
type Send = { json: unknown };

/** 제한 시간을 건 fetch 한 번. */
async function fetchOnce(path: string, ms: number, send?: Send): Promise<Attempt> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, ms);
  try {
    // signal 캐스팅: RN 타입 정의의 global.AbortSignal 과 lib.dom 의 AbortSignal
    // 선언이 어긋나 타입만 충돌한다(런타임은 같은 객체라 정상 동작).
    const init = {
      signal: ctrl.signal,
      ...(send
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(send.json),
          }
        : {}),
    } as unknown as RequestInit;
    return { kind: 'ok', res: await fetch(`${API_BASE_URL}${path}`, init) };
  } catch {
    // 우리가 끊은 것(시간 초과)과 연결 자체가 안 된 것(비행기모드 등)은 다르다.
    // 뭉뚱그리면 오프라인 사용자에게 "서버를 깨우는 중"이라는 엉뚱한 안내가 간다.
    return timedOut ? { kind: 'timeout' } : { kind: 'offline' };
  } finally {
    clearTimeout(timer);
  }
}

async function api<T>(path: string, send?: Send): Promise<T> {
  // 제한 시간이 없으면 요청이 영원히 안 끝나 화면이 로딩에서 멈춘다.
  // Render 무료 플랜은 15분 유휴 후 인스턴스를 내리므로, 잠든 서버를 깨우는
  // 첫 요청은 끊기기 쉽다 — 그때만 한 번 다시 시도한다(그 사이 서버가 깨어난다).
  const ms = timeoutFor(path);
  let a = await fetchOnce(path, ms, send);

  // 재시도는 '연결 실패'에만. 제한 시간을 다 쓴 뒤 또 기다리면 사용자가 보는
  // 대기 시간이 두 배가 된다(분석 60초 → 120초). 끊긴 연결은 대개 즉시 돌아오니
  // 재시도해도 체감이 늘지 않는다.
  if (a.kind === 'offline') {
    // POST 도 재시도해도 안전하다 — 알림 구독 등록·해지는 모두 멱등이라
    // 두 번 도착해도 결과가 같다 (서버: app/push.py subscribe/unsubscribe).
    // 사진 분석은 멱등이 아니지만(하루 횟수 1회 차감), 연결 자체가 실패한
    // 요청은 서버에 닿지 않았으므로 다시 보내도 두 번 세지 않는다.
    a = await fetchOnce(path, ms, send);
  }

  if (a.kind === 'offline') {
    throw new ApiError('네트워크에 연결할 수 없어요. 연결 상태를 확인해 주세요.', 0);
  }
  if (a.kind === 'timeout') {
    throw new ApiError(
      '서버가 응답하지 않아요. 잠시 쉬고 있던 서버를 깨우는 중일 수 있어요 — ' +
        '30초쯤 뒤에 다시 시도해 주세요.',
      0
    );
  }
  const res = a.res;
  if (res.status === 429) {
    // 레이트리밋 응답은 JSON 이 아니라 text/plain 이라 파싱하지 않는다.
    // 그대로 두면 'HTTP 429' 라는 날 코드가 화면에 뜬다.
    // 사진 분석의 '하루 10번' 한도는 JSON detail 로 온다 — 그 문장을 그대로 보여 준다.
    // (분당 제한과 달리 30초 뒤 다시 해도 소용없다)
    if ((res.headers.get('content-type') ?? '').includes('application/json')) {
      let daily: unknown = null;
      try {
        daily = ((await res.json()) as { detail?: unknown }).detail;
      } catch {
        daily = null;
      }
      if (typeof daily === 'string' && daily) {
        throw new ApiError(daily, 429);
      }
    }
    const raw = Number(res.headers.get('retry-after'));
    // 문구가 '자동으로 다시 시도한다'고 약속하면 안 된다 — 자동 재폴링을 거는
    // 화면은 스크리너뿐이고, 그 화면은 이 메시지를 아예 띄우지 않는다(백오프 후
    // 조용히 재시도). 즉 이 문구가 보이는 곳은 자동 재시도가 없는 화면뿐이다.
    throw new ApiError(
      '요청이 너무 잦아요 — 30초쯤 뒤에 다시 시도해 주세요.',
      429,
      Number.isFinite(raw) && raw > 0 ? raw : undefined
    );
  }
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body && typeof body === 'object' ? (body as { detail?: unknown }).detail : undefined;
    throw new ApiError(detailMessage(detail, res.status), res.status);
  }
  return body as T;
}

/* ---------- 종목 검색 · 분석 (내 종목 이평선) ---------- */

export function searchSymbols(q: string): Promise<SearchResponse> {
  return api<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`);
}

export function analyzeSymbol(symbol: string): Promise<AnalyzeResponse> {
  // 기간은 서버 권장 기본값(일 3년·주 7년·월 전체)을 그대로 쓴다
  return api<AnalyzeResponse>(`/api/analyze?symbol=${encodeURIComponent(symbol)}`);
}

/* ---------- 오늘의 지지선 ---------- */

export function fetchTouches(market: Market): Promise<TouchesResponse> {
  return api<TouchesResponse>(`/api/touches?market=${market}`);
}

/* ---------- 아침 브리핑 ---------- */

// 지수·공포탐욕 + 오늘 지지선 '개수'만 담긴 작은 응답. 매치 목록은 들어 있지
// 않다 — 아침 8시 반에 모두가 동시에 여는 화면이라 가볍게 유지한다.
export function fetchToday(): Promise<TodayResponse> {
  return api<TodayResponse>('/api/today').then((res) => {
    // 갱신 시각의 주인은 서버다. 응답이 올 때마다 여기서 한 번 먹여 주면,
    // 그 값을 쓰는 화면들이 각자 /api/today 를 부를 필요가 없다.
    learnRefreshAt(res.refreshAtKst);
    return res;
  });
}

/* ---------- 맞춤 이평선 ---------- */

// 사용자가 고른 기간의 이평선으로 유니버스를 훑어, 그 선의 지지를 받는 종목과
// 저항에 막힌 종목을 나눠 받는다. 서버는 (시장, 기간) 조합마다 스캐너를 두고
// 결과를 하루 고정하므로, 같은 조합을 다시 물어도 재계산이 돌지 않는다.
//
// 기간을 아무 숫자나 보내지 않고 화면이 대표 기간만 쓰는 이유: 조합 하나가
// 스캐너 하나라, 흩뿌리면 서버가 슬롯 상한(16)에 부딪혀 429 로 되민다.
export function fetchLines(market: Market, period: number): Promise<LinesResponse> {
  return api<LinesResponse>(`/api/lines?market=${market}&period=${period}`);
}

/* ---------- 차트 패턴 스크리너 ---------- */

// 한 번의 스캔 결과에 모든 패턴이 함께 들어 있다(서버가 시장별로 한 번만
// 훑는다). 그래서 패턴 칩을 바꾸는 건 같은 스냅샷에서 다른 목록을 꺼내는
// 것뿐이라, 스캔이 다시 돌지 않는다.
export function fetchPatterns(
  pattern: PatternKey,
  market: Market
): Promise<PatternsResponse> {
  return api<PatternsResponse>(`/api/patterns?pattern=${pattern}&market=${market}`);
}

/* ---------- 아침 알림 (구독 등록·해지) ---------- */

/** 알림 구독 상태 응답. ready=false 면 서버가 아직 이 기능을 켜지 않았다. */
export interface PushStatus {
  subscribed: boolean;
  ready?: boolean;
  /** 관심종목 알림용으로 서버에 맡겨 둔 종목 수. 0 이면 꺼져 있다. */
  watchCount?: number;
}

export function pushSubscribe(anonKey: string): Promise<PushStatus> {
  return api<PushStatus>('/api/push/subscribe', { json: { anonKey } });
}

export function pushUnsubscribe(anonKey: string): Promise<PushStatus> {
  return api<PushStatus>('/api/push/unsubscribe', { json: { anonKey } });
}

export function pushStatus(anonKey: string): Promise<PushStatus> {
  return api<PushStatus>('/api/push/status', { json: { anonKey } });
}

/**
 * 관심종목 알림 대상을 통째로 맞춘다. 빈 배열이면 서버에서 전부 지운다.
 *
 * '더하기'가 아니라 '맞추기'인 이유: 관심종목의 원본은 이 기기다. 더하기로
 * 두면 앱에서 뺀 종목이 서버에 남아 알림이 계속 온다.
 */
export function pushSetWatchlist(
  anonKey: string,
  symbols: string[],
): Promise<{ watchCount: number }> {
  return api<{ watchCount: number }>('/api/push/watchlist', { json: { anonKey, symbols } });
}

/* ---------- 아침 브리핑 한 줄 (알림 미리보기) ---------- */

export interface BriefResponse {
  /** 알림에 나가는 문구 그대로. */
  line: string;
  /** 슬롯별 값 — 템플릿 변수로 넘어간다. */
  vars: Record<string, string>;
  /** 기준일 (MM/DD). */
  asOf?: string | null;
  /** 값을 못 받아 문구에서 빠진 항목. */
  missing: string[];
  /** 알림 본문 길이 한도 때문에 푸시에서 빠지는 항목 (앱 화면에는 다 나온다). */
  pushDropped?: string[];
  /** 실제 알림에 나가는 본문(나스닥·공포탐욕) 그대로. */
  pushBody?: string;
}

export function fetchBrief(): Promise<BriefResponse> {
  return api<BriefResponse>('/api/brief');
}

/* ---------- 차트 사진 분석 ---------- */

export interface PhotoAnalysisRequest {
  /** 종목은 필수 — 사진에서 종목을 알아내게 하면 잘린 캡처에서 엉뚱한 종목을 분석한다. */
  symbol: string;
  name: string;
  /** base64 (data URI 접두어 없이). 서버가 파일 머리 바이트로 형식을 확인한다. */
  image: string;
  /** 하루 이용 횟수를 사람 단위로 세기 위한 익명 식별값. 없으면 서버가 IP 로 센다. */
  clientKey?: string;
}

export function analyzePhoto(req: PhotoAnalysisRequest): Promise<PhotoAnalysisResponse> {
  return api<PhotoAnalysisResponse>('/api/photo-analysis', { json: req });
}
