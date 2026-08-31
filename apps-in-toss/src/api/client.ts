import { API_BASE_URL } from '../env';
import type { AnalyzeResponse, Market, SearchResponse, TouchesResponse } from './types';

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
const TIMEOUT_MS = { search: 15000, analyze: 60000, touches: 30000, default: 30000 };

function timeoutFor(path: string): number {
  if (path.startsWith('/api/search')) return TIMEOUT_MS.search;
  if (path.startsWith('/api/analyze')) return TIMEOUT_MS.analyze;
  if (path.startsWith('/api/touches')) return TIMEOUT_MS.touches;
  return TIMEOUT_MS.default;
}

/** fetch 한 번의 결과 — 응답을 받았거나, 제한 시간을 넘겼거나, 연결 자체가 실패. */
type Attempt =
  | { kind: 'ok'; res: Response }
  | { kind: 'timeout' }
  | { kind: 'offline' };

/** 제한 시간을 건 fetch 한 번. */
async function fetchOnce(path: string, ms: number): Promise<Attempt> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, ms);
  try {
    // signal 캐스팅: RN 타입 정의의 global.AbortSignal 과 lib.dom 의 AbortSignal
    // 선언이 어긋나 타입만 충돌한다(런타임은 같은 객체라 정상 동작).
    const init = { signal: ctrl.signal } as unknown as RequestInit;
    return { kind: 'ok', res: await fetch(`${API_BASE_URL}${path}`, init) };
  } catch {
    // 우리가 끊은 것(시간 초과)과 연결 자체가 안 된 것(비행기모드 등)은 다르다.
    // 뭉뚱그리면 오프라인 사용자에게 "서버를 깨우는 중"이라는 엉뚱한 안내가 간다.
    return timedOut ? { kind: 'timeout' } : { kind: 'offline' };
  } finally {
    clearTimeout(timer);
  }
}

async function api<T>(path: string): Promise<T> {
  // 제한 시간이 없으면 요청이 영원히 안 끝나 화면이 로딩에서 멈춘다.
  // Render 무료 플랜은 15분 유휴 후 인스턴스를 내리므로, 잠든 서버를 깨우는
  // 첫 요청은 끊기기 쉽다 — 그때만 한 번 다시 시도한다(그 사이 서버가 깨어난다).
  const ms = timeoutFor(path);
  let a = await fetchOnce(path, ms);

  // 재시도는 '연결 실패'에만. 제한 시간을 다 쓴 뒤 또 기다리면 사용자가 보는
  // 대기 시간이 두 배가 된다(분석 60초 → 120초). 끊긴 연결은 대개 즉시 돌아오니
  // 재시도해도 체감이 늘지 않는다.
  if (a.kind === 'offline') {
    a = await fetchOnce(path, ms);
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
