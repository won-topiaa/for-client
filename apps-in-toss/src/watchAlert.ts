import { Storage } from '@apps-in-toss/framework';
import { useCallback, useEffect, useState } from 'react';
import { pushSetWatchlist } from './api/client';
import { anonKey } from './notify';
import { loadWatchlist, subscribeWatchlist } from './watchlist';

// 관심종목 알림 — 담아 둔 종목이 오늘 지지선에 닿으면 아침에 알려 준다.
//
// 아침 알림(notify.ts)과 **따로** 켠다. 지수만 받고 싶은 사람에게 담아 둔
// 종목까지 서버에 맡기라고 할 수 없다. 개인정보처리방침도 이 둘을 나눠서
// 적어 두었다(/privacy).
//
// 서버에는 **종목코드만** 올라간다. 이름·수량·매수가는 보내지 않는다.
//
// 동기화 규칙: 원본은 이 기기의 관심종목이고, 서버는 그 사본이다. 그래서
// '더하기'가 아니라 통째로 '맞추기'다 — 앱에서 뺀 종목이 서버에 남으면
// 사용자는 지운 줄 아는데 알림은 계속 온다.

const FLAG_KEY = 'wontopia.watchAlert';

/** 서버가 보관하는 상한(app/push.py MAX_WATCH_SYMBOLS)과 같은 값.
 *
 *  앱에서도 잘라 보내는 이유: 서버는 초과분을 조용히 버리는데, 화면이 담아 둔
 *  개수를 그대로 말하면 50개를 담은 사람에게 "50개를 보고 있어요"라고 하면서
 *  실제로는 30개만 본다. 같은 수를 양쪽이 알아야 한다.
 *
 *  관심종목은 최근에 담은 것이 앞에 오도록 정렬돼 있으므로(watchlist.ts),
 *  앞에서 자르면 '최근 30개'가 남는다. */
export const WATCH_ALERT_MAX = 30;

/** 알림이 실제로 보고 있는 종목 수 — 화면이 이 값을 말해야 한다. */
export function watchedForAlert(total: number): number {
  return Math.min(total, WATCH_ALERT_MAX);
}

/** 여러 종목을 연달아 담을 때 매번 올리지 않게 잠깐 모은다. */
const SYNC_DEBOUNCE_MS = 2000;

let enabled = false;
let loaded = false;
const listeners = new Set<(on: boolean) => void>();

let unsubscribeList: (() => void) | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function emit(on: boolean): void {
  for (const fn of listeners) {
    fn(on);
  }
}

/** 지금 기기의 관심종목을 서버와 맞춘다. 꺼져 있으면 아무것도 하지 않는다. */
async function syncNow(): Promise<void> {
  if (!enabled) {
    return;
  }
  const items = await loadWatchlist();
  if (items === null) {
    return; // 저장소를 못 읽었다 — 빈 목록으로 덮어쓰면 알림이 조용히 끊긴다
  }
  const key = await anonKey();
  await pushSetWatchlist(key, items.slice(0, WATCH_ALERT_MAX).map((x) => x.symbol));
}

function scheduleSync(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    // 실패는 조용히 넘긴다 — 다음 변경이나 다음 실행에서 다시 맞춘다.
    // 여기서 화면에 오류를 띄우면 별을 누른 것과 상관없는 곳에 빨간 글씨가 뜬다.
    void syncNow().catch(() => undefined);
  }, SYNC_DEBOUNCE_MS);
}

/** 관심종목이 바뀔 때마다 서버를 맞추도록 붙인다(켜져 있을 때만). */
function attachListener(): void {
  if (unsubscribeList || !enabled) {
    return;
  }
  unsubscribeList = subscribeWatchlist(scheduleSync);
}

function detachListener(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  unsubscribeList?.();
  unsubscribeList = null;
}

/** 저장해 둔 설정을 한 번 읽는다. 실패는 캐시하지 않는다. */
async function loadFlag(): Promise<void> {
  if (loaded) {
    return;
  }
  let raw: string | null = null;
  try {
    raw = await Storage.getItem(FLAG_KEY);
  } catch {
    return; // 다음 호출이 다시 시도한다
  }
  loaded = true;
  const on = raw === '1';
  if (on !== enabled) {
    enabled = on;
    emit(on);
  }
  if (enabled) {
    attachListener();
    // 켜 둔 채로 앱을 껐다 켜는 사이에 관심종목이 바뀌었을 수 있다
    void syncNow().catch(() => undefined);
  }
}

/**
 * 켜기/끄기. 끄면 서버에 있는 종목코드를 **지운다**(빈 목록으로 맞춘다) —
 * 방침이 '끄시면 즉시 삭제'를 약속한다.
 *
 * 화면 상태를 먼저 바꾸고 서버를 뒤따르게 한다. 실패하면 되돌려 알린다 —
 * 껐다고 보여 주는데 서버에 남아 있으면 약속을 어긴 것이 된다.
 */
export async function setWatchAlert(on: boolean): Promise<void> {
  const before = enabled;
  enabled = on;
  loaded = true;
  emit(on);
  try {
    const key = await anonKey();
    if (on) {
      const items = await loadWatchlist();
      await pushSetWatchlist(
        key,
        (items ?? []).slice(0, WATCH_ALERT_MAX).map((x) => x.symbol),
      );
      attachListener();
    } else {
      detachListener();
      await pushSetWatchlist(key, []);
    }
  } catch (err) {
    enabled = before;
    emit(before);
    if (before) {
      attachListener();
    } else {
      detachListener();
    }
    throw err;
  }
  void Storage.setItem(FLAG_KEY, on ? '1' : '0').catch(() => undefined);
}

/**
 * 서버가 알려준 보관 개수로 설정을 바로잡는다.
 *
 * 기기 저장소가 비어도(앱 재설치 등) 서버에 종목이 남아 있으면 알림은 계속
 * 간다. 그때 화면이 '꺼짐'으로 보이면 끌 방법이 없다 — 서버를 따른다.
 */
export function reconcileWatchAlert(watchCount: number | undefined): void {
  if (watchCount === undefined) {
    return;
  }
  const on = watchCount > 0;
  if (!on || enabled) {
    return; // 꺼져 있는 것은 저장소 쪽이 맞다(담은 종목이 0개일 수 있다)
  }
  enabled = true;
  loaded = true;
  emit(true);
  attachListener();
  void Storage.setItem(FLAG_KEY, '1').catch(() => undefined);
}

/** 아침 알림을 끄면 관심종목 알림도 의미가 없다 — 함께 내린다.
 *  (서버는 구독 해지 시 종목코드도 같이 지운다) */
export function forgetWatchAlert(): void {
  if (!enabled) {
    return;
  }
  enabled = false;
  emit(false);
  detachListener();
  void Storage.setItem(FLAG_KEY, '0').catch(() => undefined);
}

/**
 * 앱이 켜질 때 한 번 부른다 (_app.tsx).
 *
 * 이게 없으면 관심종목 변경을 듣는 자리가 알림 설정 화면에만 붙는다 — 그
 * 화면에 안 들어간 날에는 별을 담거나 빼도 서버에 닿지 않아서, 뺀 종목의
 * 알림이 계속 오는 바로 그 상황이 된다. (이 모듈이 막겠다고 적어 둔 것이다)
 */
export function initWatchAlert(): void {
  void loadFlag();
}

export function useWatchAlert(): { on: boolean; setOn: (v: boolean) => Promise<void> } {
  const [on, setLocal] = useState(enabled);
  useEffect(() => {
    listeners.add(setLocal);
    void loadFlag().then(() => setLocal(enabled));
    return () => {
      listeners.delete(setLocal);
    };
  }, []);
  const setOn = useCallback((v: boolean) => setWatchAlert(v), []);
  return { on, setOn };
}
