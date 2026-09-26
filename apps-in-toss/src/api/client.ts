import { API_BASE_URL } from '../env';
import type {
  AnalyzeResponse,
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

/** 본문을 보내는 요청(POST)의 재료. 없으면 GET.
 *  once: 연결이 끊겨도 다시 보내지 않는다 — 두 번 도착하면 안 되는 요청(사진 분석). */
type Send = { json: unknown; once?: boolean };

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
  if (a.kind === 'offline' && !send?.once) {
    // 알림 구독 등록·해지 POST 는 멱등이라 두 번 도착해도 결과가 같다
    // (서버: app/push.py subscribe/unsubscribe). 사진 분석은 다르다 — fetch 가
    // 실패했다고 서버에 안 닿았다는 보장이 없다(본문을 다 올린 뒤 끊긴 연결도
    // 같은 예외로 온다). 다시 보내면 하루 횟수가 두 번 깎인다 — once 로 막는다.
    a = await fetchOnce(path, ms, send);
  }

  if (a.kind === 'offline') {
    throw new ApiError(
      send?.once
        ? '연결이 끊겼어요. 연결 상태를 확인하고 다시 시도해 주세요.'
        : '네트워크에 연결할 수 없어요. 연결 상태를 확인해 주세요.',
      0
    );
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
    // 분당 제한은 Retry-After 헤더(초)를 함께 보낸다 — 폴링 화면이 그만큼 물러선다.
    // 사진 분석의 '하루 10번' 한도는 헤더 없이 JSON detail 만 온다(30초 뒤 다시 해도 소용없다).
    const raw = Number(res.headers.get('retry-after'));
    const retryAfter = Number.isFinite(raw) && raw > 0 ? raw : undefined;
    let detail: unknown = null;
    if ((res.headers.get('content-type') ?? '').includes('application/json')) {
      try {
        detail = ((await res.json()) as { detail?: unknown }).detail;
      } catch {
        detail = null;
      }
    }
    // 문구가 '자동으로 다시 시도한다'고 약속하면 안 된다 — 자동 재폴링을 거는
    // 화면은 이 메시지를 아예 띄우지 않는다(백오프 후 조용히 재시도).
    throw new ApiError(
      typeof detail === 'string' && detail ? detail : '요청이 너무 잦아요 — 30초쯤 뒤에 다시 시도해 주세요.',
      429,
      retryAfter
    );
  }
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body && typeof body === 'object' ? (body as { detail?: unknown }).detail : undefined;
    // 배포 재시작·메모리 초과 때 Render 가 HTML 502/503 을 돌려준다 — 'HTTP 502' 날 코드 대신
    if (res.status >= 500 && typeof detail !== 'string') {
      throw new ApiError('서버가 잠시 불안정해요. 잠시 후 다시 시도해 주세요.', res.status);
    }
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
  // 한 번만 보낸다 — 서버가 받자마자 하루 횟수를 깎는다 (위 api() 의 once 참고)
  return api<PhotoAnalysisResponse>('/api/photo-analysis', { json: req, once: true });
}
