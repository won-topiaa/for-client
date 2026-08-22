import { Storage } from '@apps-in-toss/framework';
import { API_BASE_URL } from '../env';
import type {
  AnalyzeResponse,
  AuthResponse,
  Market,
  SearchResponse,
  TouchesResponse,
} from './types';

const TOKEN_KEY = 'wontopia.session';

// Storage 브리지가 실패해도(구버전 토스 앱 등) 세션 동안은 메모리로 동작한다.
let cachedToken: string | null | undefined;

export async function getToken(): Promise<string | null> {
  if (cachedToken !== undefined) {
    return cachedToken;
  }
  try {
    cachedToken = await Storage.getItem(TOKEN_KEY);
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

async function setToken(token: string | null): Promise<void> {
  cachedToken = token;
  try {
    if (token == null) {
      await Storage.removeItem(TOKEN_KEY);
    } else {
      await Storage.setItem(TOKEN_KEY, token);
    }
  } catch {
    // 저장 실패는 치명적이지 않다 — 다음 실행에서 다시 로그인하면 된다
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
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

async function api<T>(
  path: string,
  init?: { method?: 'GET' | 'POST'; body?: unknown; auth?: boolean }
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (init?.auth) {
    const token = await getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    // 무료 플랜 서버는 15분 유휴 후 잠들어 첫 요청이 오래 걸리거나 끊길 수 있다
    throw new ApiError('서버에 연결하지 못했어요 — 잠시 후 다시 시도해 주세요.', 0);
  }
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body && typeof body === 'object' ? (body as { detail?: unknown }).detail : undefined;
    throw new ApiError(detailMessage(detail, res.status), res.status);
  }
  return body as T;
}

/* ---------- 종목 검색 · 분석 (이평선 레이더) ---------- */

export function searchSymbols(q: string): Promise<SearchResponse> {
  return api<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`);
}

export function analyzeSymbol(symbol: string): Promise<AnalyzeResponse> {
  // 기간은 서버 권장 기본값(일 3년·주 7년·월 전체)을 그대로 쓴다
  return api<AnalyzeResponse>(`/api/analyze?symbol=${encodeURIComponent(symbol)}`);
}

/* ---------- 오늘의 지지선 터치 (회원 전용) ---------- */

export function fetchTouches(market: Market): Promise<TouchesResponse> {
  return api<TouchesResponse>(`/api/touches?market=${market}`, { auth: true });
}

/* ---------- 이메일 회원 인증 (사이트와 계정 공용) ---------- */

export async function login(email: string, password: string): Promise<AuthResponse> {
  const body = await api<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: { email, password, client: 'app' },
  });
  if (body.token) {
    await setToken(body.token);
  }
  return body;
}

export async function signup(email: string, password: string): Promise<AuthResponse> {
  const body = await api<AuthResponse>('/api/auth/signup', {
    method: 'POST',
    body: { email, password, client: 'app' },
  });
  if (body.token) {
    await setToken(body.token);
  }
  return body;
}

export async function logout(): Promise<void> {
  try {
    await api('/api/auth/logout', { method: 'POST', auth: true });
  } catch {
    // 서버 측 세션 정리가 실패해도 로컬 토큰은 지운다
  }
  await setToken(null);
}

export async function me(): Promise<string | null> {
  try {
    const body = await api<{ email: string }>('/api/auth/me', { auth: true });
    return body.email;
  } catch (err) {
    if (isAuthError(err)) {
      await setToken(null); // 만료된 토큰 정리
    }
    return null;
  }
}

/** 401 을 받았을 때 화면에서 호출 — 만료 토큰을 지워 로그인 화면으로 유도 */
export function clearSession(): Promise<void> {
  return setToken(null);
}
