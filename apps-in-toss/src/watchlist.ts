import { Storage } from '@apps-in-toss/framework';
import { useCallback, useEffect, useState } from 'react';
import type { SymbolInfo } from './api/types';

// 관심종목 — 기기 로컬 저장.
// 앱인토스 정책상 로그인이 없어(README 참고) 계정에 묶을 수 없다. 그래서 토스
// Storage 에 기기별로 저장한다. 기기를 바꾸면 목록은 따라가지 않는다.

const KEY = 'wontopia.watchlist';
/** 저장 한도 — 초과분은 오래된 것부터 버린다 (Storage 용량·렌더 비용 보호). */
const MAX_ITEMS = 200;

export interface WatchItem {
  symbol: string;
  name: string;
  market?: string | null;
  /** 추가 시각(ms). 최신순 정렬에 쓴다. */
  addedAt: number;
}

let cache: WatchItem[] | null = null; // null = 아직 못 읽음(미시도 또는 실패)
let storageBroken = false; // 읽기/쓰기가 실패한 상태 — 화면에 알린다

const listeners = new Set<(items: WatchItem[]) => void>();
const statusListeners = new Set<(broken: boolean) => void>();

/** 저장소에서 읽은 값이 우리가 쓴 모양인지 검사 — 손상된 값에 화면이 깨지지 않게. */
function parse(raw: string | null): WatchItem[] {
  if (!raw) {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) {
    return [];
  }
  const out: WatchItem[] = [];
  const seen = new Set<string>();
  for (const x of data) {
    if (!x || typeof x !== 'object') {
      continue;
    }
    const { symbol, name, market, addedAt } = x as Record<string, unknown>;
    if (typeof symbol !== 'string' || !symbol || seen.has(symbol)) {
      continue;
    }
    seen.add(symbol);
    out.push({
      symbol,
      name: typeof name === 'string' && name ? name : symbol,
      market: typeof market === 'string' ? market : null,
      addedAt: typeof addedAt === 'number' && Number.isFinite(addedAt) ? addedAt : 0,
    });
  }
  return out;
}

function sorted(items: WatchItem[]): WatchItem[] {
  return [...items].sort((a, b) => b.addedAt - a.addedAt);
}

function emit(items: WatchItem[]): void {
  for (const fn of listeners) {
    fn(items);
  }
}

function setBroken(next: boolean): void {
  if (storageBroken === next) {
    return;
  }
  storageBroken = next;
  for (const fn of statusListeners) {
    fn(next);
  }
}

// 저장만 한 줄로 세운다. 목록 갱신 자체는 동기라(applyChange) 유실될 일이 없고,
// Storage 쓰기만 순서가 뒤집히면 오래된 목록이 마지막에 기록될 수 있다.
let writeQueue: Promise<unknown> = Promise.resolve();

function queuePersist(items: WatchItem[]): void {
  const run = writeQueue.then(async () => {
    try {
      await Storage.setItem(KEY, JSON.stringify(items));
      setBroken(false);
    } catch {
      // 저장 실패를 삼키면 화면은 담긴 것처럼 보이는데 다음 실행에 사라진다.
      // 사용자에게 알릴 수 있게 상태로 남긴다.
      setBroken(true);
    }
  });
  writeQueue = run.catch(() => undefined); // 실패해도 큐가 막히지 않게
}

/**
 * 저장소에서 한 번만 읽어 캐시한다.
 *
 * 읽기에 실패하면 **빈 목록을 캐시하지 않고** null 을 돌려준다. 실패를 '목록이
 * 없음'으로 캐시하면, 그 상태에서 별을 하나 누르는 순간 기존에 저장돼 있던
 * 목록 전체가 한 건짜리 목록으로 덮어써져 사라진다. null 로 두면 다음 호출이
 * 다시 읽어 일시적 실패에서 회복된다.
 */
export async function loadWatchlist(): Promise<WatchItem[] | null> {
  if (cache !== null) {
    return cache;
  }
  let raw: string | null;
  try {
    raw = await Storage.getItem(KEY);
  } catch {
    setBroken(true);
    return null;
  }
  // 동시에 여러 화면이 부르면 먼저 끝난 쪽이 캐시를 채운다 — 덮어쓰지 않는다
  if (cache === null) {
    cache = sorted(parse(raw));
  }
  setBroken(false);
  return cache;
}

export function isWatched(items: WatchItem[], symbol: string): boolean {
  return items.some((x) => x.symbol === symbol);
}

/**
 * 캐시를 동기적으로 고치고 알린다.
 *
 * 동기인 것이 중요하다 — await 를 사이에 끼우면 두 번 연달아 누른 토글이
 * 같은 목록을 읽어 뒤엣것이 앞엣것을 덮어쓴다(별 하나가 조용히 사라짐).
 * 저장(Storage)만 뒤에서 직렬로 흘려보낸다.
 */
function applyChange(change: (items: WatchItem[]) => WatchItem[]): boolean {
  if (cache === null) {
    return false; // 저장소를 못 읽은 상태 — 건드리면 기존 목록을 날린다
  }
  const next = change(cache);
  cache = next;
  emit(next);
  queuePersist(next);
  return true;
}

/** 관심종목 토글 — 담겼으면 true, 빠졌으면 false. 저장소를 못 읽으면 false. */
export async function toggleWatch(item: SymbolInfo): Promise<boolean> {
  if (cache === null) {
    await loadWatchlist(); // 첫 탭에서만 — 이후는 캐시라 동기로 흐른다
  }
  let added = false;
  applyChange((items) => {
    if (isWatched(items, item.symbol)) {
      return items.filter((x) => x.symbol !== item.symbol);
    }
    added = true;
    return sorted([
      {
        symbol: item.symbol,
        name: item.name || item.symbol,
        market: item.market ?? null,
        addedAt: Date.now(),
      },
      ...items,
    ]).slice(0, MAX_ITEMS);
  });
  return added;
}

export async function removeWatch(symbol: string): Promise<void> {
  if (cache === null) {
    await loadWatchlist();
  }
  applyChange((items) => items.filter((x) => x.symbol !== symbol));
}

/**
 * 관심종목 목록과 토글을 쓰는 훅.
 *
 * 모듈 캐시를 구독하므로 여러 화면(레이더·스크리너·관심종목)이 같은 목록을
 * 본다 — 한 화면에서 별을 누르면 다른 화면도 즉시 따라 바뀐다.
 *
 * `saveBroken` 이 true 면 저장소를 읽거나 쓰지 못한 상태다. 화면은 이때
 * "저장되지 않는다"고 알려야 한다 — 안 그러면 담긴 것처럼 보이다가 다음
 * 실행에 사라진다.
 */
export function useWatchlist() {
  const [items, setItems] = useState<WatchItem[]>(cache ?? []);
  const [ready, setReady] = useState(cache !== null);
  const [saveBroken, setSaveBroken] = useState(storageBroken);

  useEffect(() => {
    let alive = true;
    listeners.add(setItems);
    statusListeners.add(setSaveBroken);
    void loadWatchlist().then((loaded) => {
      if (alive) {
        setItems(loaded ?? []);
        setReady(true);
      }
    });
    return () => {
      alive = false;
      listeners.delete(setItems);
      statusListeners.delete(setSaveBroken);
    };
  }, []);

  const toggle = useCallback((item: SymbolInfo) => toggleWatch(item), []);
  const remove = useCallback((symbol: string) => removeWatch(symbol), []);

  return { items, ready, saveBroken, toggle, remove };
}
