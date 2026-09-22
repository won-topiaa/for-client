import { Storage } from '@apps-in-toss/framework';
import { useSyncExternalStore } from 'react';

// 스크리너 결과가 하루 한 번 새로 계산되는 시각(KST) — 앱이 말하는 '오늘'의 경계다.
//
// 이 값의 주인은 서버(DAILY_REFRESH_KST)다. 앱이 따로 적어 두면 서버 설정을
// 바꾸는 순간 조용히 어긋난다: 홈 브리핑 카드는 서버가 준 새 시각을 말하는데
// 관심종목 '오늘 지지선' 배지는 옛 경계로 오늘/어제를 가른다. 같은 앱의 두
// 화면이 서로 다른 날짜의 결과를 보여주는 셈이라, 한쪽만 틀린 것보다 나쁘다.
//
// 그래서 /api/today 응답이 올 때마다 여기에 배워 둔다(api/client.ts 의
// fetchToday 가 먹여 준다). 배운 값은 저장해 두는데, 다음에 앱을 열었을 때
// 응답이 오기 전까지 옛 경계를 쓰지 않기 위해서다 — 딱 그 틈이 배지가 어제
// 것을 보여주는 구간이다.

const KEY = 'wontopia.refreshAtKst';

/** 서버가 아직 아무 말도 하지 않았을 때의 출발점. '진실'이 아니라 부팅값이다.
 *  진실은 /api/today 의 refreshAtKst 이고, 서버 기본값(app/pattern_scan.py 의
 *  DAILY_REFRESH_KST)과 같은 값을 적어 둔다. */
const FALLBACK_MIN = 6 * 60 + 30; // 06:30

let refreshMin = FALLBACK_MIN;
/** 서버 값을 한 번이라도 받았는가. 저장소에서 늦게 올라온 옛 값이
 *  방금 받은 서버 값을 덮어쓰지 못하게 막는다. */
let learned = false;

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      // 구독자 하나가 터져도 나머지에게는 알려야 한다
    }
  }
}

/** "HH:MM" → 자정부터의 분. 형식이 어긋나면 null — 서버가 이상한 값을 주더라도
 *  경계가 엉뚱한 데로 옮겨가지 않게 한다. */
export function parseRefreshAt(raw: unknown): number | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (m == null) {
    return null;
  }
  const hour = Number(m[1]);
  const min = Number(m[2]);
  if (hour > 23 || min > 59) {
    return null;
  }
  return hour * 60 + min;
}

function apply(min: number, fromServer: boolean): void {
  if (fromServer) {
    learned = true;
  }
  if (min === refreshMin) {
    return;
  }
  refreshMin = min;
  emit();
}

// 저장 순서를 한 줄로 세운다. 값이 바뀔 때만 쓰므로 거의 돌지 않지만,
// 겹쳐 쓰면 옛 값이 마지막에 남을 수 있다.
let writeQueue: Promise<unknown> = Promise.resolve();

/** /api/today 응답에서 배운다. 호출은 fetchToday 한 곳뿐이다. */
export function learnRefreshAt(raw: unknown): void {
  const min = parseRefreshAt(raw);
  if (min == null) {
    return; // 서버가 안 줬거나 형식이 깨졌다 — 쓰던 값을 그대로 둔다
  }
  const changed = min !== refreshMin;
  apply(min, true);
  if (changed) {
    const text = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    writeQueue = writeQueue.then(() => Storage.setItem(KEY, text)).catch(() => undefined);
  }
}

/** 앱 시작 때 저장해 둔 값을 되살린다 (_app.tsx 에서 한 번).
 *
 * 실패해도 재시도하지 않는다. 몇 초 뒤 /api/today 가 진짜 값을 물어다 주고,
 * 그때까지는 부팅값을 쓸 뿐이다 — 재시도 장치를 더 달아서 얻는 게 없다. */
export function initRefreshDay(): void {
  void (async () => {
    let raw: string | null = null;
    try {
      raw = await Storage.getItem(KEY);
    } catch {
      return;
    }
    if (learned) {
      return; // 서버가 이미 말해 줬다 — 저장된 값은 그보다 낡았다
    }
    const min = parseRefreshAt(raw);
    if (min != null) {
      apply(min, false);
    }
  })();
}

/** 갱신 시각 기준의 '오늘' 키 (YYYY-MM-DD).
 *
 * 갱신 시각만큼 시계를 뒤로 민 뒤 날짜를 읽는다. 06:30 갱신이면 06:29 까지는
 * 어제 키, 06:30 부터 오늘 키가 된다. */
export function refreshDayKey(): string {
  const kstNow = Date.now() + 9 * 60 * 60 * 1000; // UTC → KST
  return new Date(kstNow - refreshMin * 60 * 1000).toISOString().slice(0, 10);
}

/** 경계가 바뀌면 알려 준다. 해제 함수를 돌려준다. */
export function subscribeRefreshDay(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 지금의 '오늘' 키를 주고, 경계를 새로 배우면 다시 그린다.
 *
 * 화면이 키를 한 번 계산해 두고 말면, 앱이 떠 있는 동안 서버 값을 배워도
 * 그 화면만 옛 경계로 남는다. 키가 바뀌면 그 키로 캐시를 다시 따지게 한다.
 *
 * useState + useEffect 대신 useSyncExternalStore 를 쓰는 이유: 구독은 렌더가
 * 끝난 뒤에 붙는다. 그 사이에 /api/today 응답이 도착하면 알림을 놓쳐 이 화면만
 * 옛 키로 남는데, useSyncExternalStore 는 구독 직후 스냅샷을 다시 읽어 그 틈을
 * 스스로 메운다. (키는 문자열이라 값이 같으면 다시 그리지 않는다.) */
export function useRefreshDayKey(): string {
  return useSyncExternalStore(subscribeRefreshDay, refreshDayKey);
}
