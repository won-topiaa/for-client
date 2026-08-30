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

async function api<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`);
  } catch {
    // 무료 플랜 서버는 15분 유휴 후 잠들어 첫 요청이 오래 걸리거나 끊길 수 있다
    throw new ApiError('서버에 연결하지 못했어요 — 잠시 후 다시 시도해 주세요.', 0);
  }
  if (res.status === 429) {
    // 레이트리밋 응답은 JSON 이 아니라 text/plain 이라 파싱하지 않는다.
    // 그대로 두면 'HTTP 429' 라는 날 코드가 화면에 뜬다.
    const raw = Number(res.headers.get('retry-after'));
    throw new ApiError(
      '요청이 너무 잦아요 — 잠시 뒤 자동으로 다시 시도할게요.',
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
