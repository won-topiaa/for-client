import { getAnonymousKey, requestNotificationAgreement, Storage } from '@apps-in-toss/framework';
import { useCallback, useEffect, useRef, useState } from 'react';
import { pushStatus, pushSubscribe, pushUnsubscribe } from './api/client';
import { PUSH_TEMPLATE_CODE } from './env';

// 아침 시장 알림 — 동의 받기와 구독 등록.
//
// 흐름
// ────
// ① 토스 알림 동의 화면을 띄운다 (requestNotificationAgreement).
// ② getAnonymousKey() 로 이 기기의 사용자 식별키를 받는다.
// ③ 그 키를 우리 서버에 등록한다 — 토스는 동의 결과를 우리 서버에 알려주지
//    않으므로(콜백은 앱에만 온다), '누구에게 보낼지'는 우리가 들고 있어야 한다.
//
// 끄기는 우리 서버의 발송 목록에서 빼는 것이다. 토스에 준 동의 자체는 토스
// 설정에 남는다 — 앱에서 철회하는 API 가 없다. 화면 문구도 그렇게 적어야 한다.

/** 화면이 기억해 두는 '켜 둔 상태' — 서버 확인 전에도 스위치가 바로 맞게 보이도록. */
const FLAG_KEY = 'wontopia.morningPush';

/** 동의 화면이 열린 채 사용자가 떠나면 콜백이 오지 않는다 — 영원히 '처리 중'에
 *  머물지 않게 안전장치를 둔다. 사람이 동의 화면을 읽는 시간을 넉넉히 넘긴 값. */
const AGREEMENT_TIMEOUT_MS = 180_000;

/** 이 기능을 쓸 수 있는가 — 콘솔에서 받은 템플릿 코드가 있어야 동의 화면이 열린다. */
export function isPushAvailable(): boolean {
  return PUSH_TEMPLATE_CODE.trim().length > 0;
}

// 식별키는 세션 동안만 메모리에 둔다. 저장소에 적어 둘 이유가 없고(브리지에서
// 언제든 다시 받는다) 굳이 기기에 남길 값도 아니다.
let cachedKey: string | null = null;

export class NotifyError extends Error {
  constructor(
    message: string,
    /** 토스 앱이 오래돼 기능 자체가 없는 경우 — 안내 문구가 달라진다. */
    readonly kind: 'unsupported' | 'failed' = 'failed'
  ) {
    super(message);
    this.name = 'NotifyError';
  }
}

/** 이 기기의 사용자 식별키. 못 받으면 NotifyError. */
async function anonKey(): Promise<string> {
  if (cachedKey) {
    return cachedKey;
  }
  let got: Awaited<ReturnType<typeof getAnonymousKey>>;
  try {
    got = await getAnonymousKey();
  } catch {
    throw new NotifyError('토스에서 사용자 정보를 받지 못했어요. 잠시 후 다시 시도해 주세요.');
  }
  // 이 함수는 예외를 던지는 대신 'ERROR' 문자열이나 undefined 를 돌려줄 수 있다.
  // undefined = 토스 앱 버전이 이 기능의 최소 지원 버전보다 낮다는 뜻.
  if (got === undefined) {
    throw new NotifyError('토스 앱을 최신 버전으로 업데이트하면 알림을 받을 수 있어요.', 'unsupported');
  }
  if (got === 'ERROR' || typeof got !== 'object' || typeof got.hash !== 'string' || !got.hash) {
    throw new NotifyError('토스에서 사용자 정보를 받지 못했어요. 잠시 후 다시 시도해 주세요.');
  }
  cachedKey = got.hash;
  return cachedKey;
}

/**
 * requestNotificationAgreement 의 에러를 사람이 읽을 안내로 바꾼다.
 *
 * 문서에 나온 error.code 별 처리 (developers-apps-in-toss smart-message):
 * - UNSUPPORTED_APP_VERSION: 토스 앱이 이 기능의 최소 버전보다 낮다 → 업데이트 안내
 * - TERMS_DISAGREED_MEMBER: 토스 '사용자 최적화 제품 동의'가 꺼져 있어 도달 불가
 *   → 어디서 켜는지 알려 준다 (안 그러면 '왜 안 오지'로 남는다)
 * - 그 외(NOTIFICATION_AGREEMENT_FAILED 등)는 일반 안내
 */
function agreementError(error: unknown): NotifyError {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  if (code === 'UNSUPPORTED_APP_VERSION') {
    return new NotifyError(
      '토스 앱을 최신 버전으로 업데이트하면 알림을 받을 수 있어요.',
      'unsupported'
    );
  }
  if (code === 'TERMS_DISAGREED_MEMBER') {
    return new NotifyError(
      '토스 설정 > 약관 및 개인정보 처리 동의 > \'사용자 최적화 제품 동의\'를 켜면 알림을 받을 수 있어요.'
    );
  }
  return new NotifyError('알림 동의를 받지 못했어요. 다시 시도해 주세요.');
}

/** 토스 알림 동의 화면을 띄우고 결과를 기다린다. */
function askAgreement(): Promise<'agreed' | 'rejected'> {
  return new Promise((resolve, reject) => {
    let done = false;
    // cleanup 은 requestNotificationAgreement 의 반환값이라 아래에서 채워진다.
    // 콜백이 그보다 먼저 불릴 수 있으므로 함수로 감싸 늦게 읽는다.
    let cleanup: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (fn: () => void) => {
      if (done) {
        return; // 콜백이 두 번 와도 한 번만 처리한다
      }
      done = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      try {
        cleanup?.();
      } catch {
        // 해제 실패는 사용자에게 알릴 일이 아니다
      }
      fn();
    };

    timer = setTimeout(
      () =>
        finish(() =>
          reject(new NotifyError('동의 화면이 응답하지 않았어요. 다시 시도해 주세요.'))
        ),
      AGREEMENT_TIMEOUT_MS
    );

    try {
      cleanup = requestNotificationAgreement({
        options: { templateCode: PUSH_TEMPLATE_CODE },
        onEvent: (result) =>
          finish(() =>
            // alreadyAgreed 도 '동의함'으로 본다 — 앱을 지웠다 깔면 토스의 동의는
            // 남아 있지만 우리 서버의 목록은 비어 있어서, 여기서 다시 등록해야 한다.
            resolve(result?.type === 'agreementRejected' ? 'rejected' : 'agreed')
          ),
        onError: (error) => finish(() => reject(agreementError(error))),
      });
      if (done) {
        // 콜백이 동기로 불린 경우 — finish 가 이미 지나갔고 그때 cleanup 은
        // 아직 null 이었다. 여기서 직접 해제하지 않으면 구독이 남는다.
        try {
          cleanup?.();
        } catch {
          // 해제 실패는 사용자에게 알릴 일이 아니다
        }
      }
    } catch (error) {
      finish(() => reject(agreementError(error)));
    }
  });
}

async function rememberFlag(on: boolean): Promise<void> {
  try {
    await Storage.setItem(FLAG_KEY, on ? '1' : '0');
  } catch {
    // 기억에 실패해도 서버 목록이 진실이라 기능은 정상 — 조용히 넘어간다
  }
}

async function readFlag(): Promise<boolean> {
  try {
    return (await Storage.getItem(FLAG_KEY)) === '1';
  } catch {
    return false;
  }
}

export interface MorningPush {
  /** 알림을 받는 상태인가 (서버 목록 기준). */
  enabled: boolean;
  /** 처음 상태를 확인하는 중. */
  loading: boolean;
  /** 켜기/끄기 처리 중 — 버튼을 잠근다. */
  busy: boolean;
  /** 사람에게 보여 줄 문제 설명. */
  problem: string | null;
  /** 토스 앱이 오래돼 기능을 쓸 수 없음. */
  unsupported: boolean;
  /** 서버가 아직 이 기능을 켜지 않음. */
  serverNotReady: boolean;
  toggle: () => void;
}

/** 아침 알림 스위치 상태. */
export function useMorningPush(): MorningPush {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [serverNotReady, setServerNotReady] = useState(false);
  // 화면을 떠난 뒤 setState 하면 경고가 나고, 두 번 누르면 요청이 겹친다
  const alive = useRef(true);
  const working = useRef(false);

  useEffect(() => {
    alive.current = true;
    void (async () => {
      // 저장해 둔 값으로 먼저 그린다 — 서버 확인(수 초)을 기다리며 스위치가
      // 꺼진 채로 보이면, 켜 둔 사용자가 다시 누르게 된다.
      const remembered = await readFlag();
      if (!alive.current) {
        return;
      }
      setEnabled(remembered);
      if (!isPushAvailable()) {
        setLoading(false);
        return;
      }
      try {
        const key = await anonKey();
        const res = await pushStatus(key);
        if (!alive.current) {
          return;
        }
        // 서버 목록이 진실이다 — 기억해 둔 값과 다르면 서버를 따른다
        setEnabled(!!res.subscribed);
        setServerNotReady(res.ready === false);
        void rememberFlag(!!res.subscribed);
      } catch (err) {
        if (!alive.current) {
          return;
        }
        // 확인 실패는 문제로 띄우지 않는다 — 화면을 열자마자 빨간 글씨가 뜨면
        // 사용자는 자기가 뭘 잘못한 줄 안다. 켜고 끌 때의 실패만 알린다.
        if (err instanceof NotifyError && err.kind === 'unsupported') {
          setUnsupported(true);
        }
      } finally {
        if (alive.current) {
          setLoading(false);
        }
      }
    })();
    return () => {
      alive.current = false;
    };
  }, []);

  const toggle = useCallback(() => {
    if (working.current) {
      return; // 연타 방어 — 동의 화면이 두 번 열리지 않게
    }
    working.current = true;
    setBusy(true);
    setProblem(null);
    void (async () => {
      try {
        if (!isPushAvailable()) {
          throw new NotifyError('알림 기능을 준비 중이에요. 곧 켜질 거예요.');
        }
        if (enabled) {
          const key = await anonKey();
          const res = await pushUnsubscribe(key);
          if (!alive.current) {
            return;
          }
          // 서버 목록이 진실이다 — 응답을 무시하고 꺼진 것으로 그리면,
          // 실제로는 목록에 남아 있는데 사용자는 껐다고 믿게 된다.
          const off = res.subscribed !== true;
          setEnabled(!off);
          await rememberFlag(!off);
          if (!off) {
            setProblem('알림을 끄지 못했어요. 잠시 후 다시 시도해 주세요.');
          }
          return;
        }
        // 동의를 먼저 받는다. 거부한 사람의 식별키를 서버에 남기지 않기 위해서다.
        const decision = await askAgreement();
        if (!alive.current) {
          return;
        }
        if (decision === 'rejected') {
          setProblem('알림 동의를 하지 않으면 아침 알림을 보낼 수 없어요.');
          return;
        }
        const key = await anonKey();
        const res = await pushSubscribe(key);
        if (!alive.current) {
          return;
        }
        setEnabled(res.subscribed !== false);
        await rememberFlag(res.subscribed !== false);
      } catch (err) {
        if (!alive.current) {
          return;
        }
        if (err instanceof NotifyError && err.kind === 'unsupported') {
          setUnsupported(true);
        }
        setProblem(err instanceof Error ? err.message : '알림 설정에 실패했어요.');
      } finally {
        working.current = false;
        if (alive.current) {
          setBusy(false);
        }
      }
    })();
  }, [enabled]);

  return { enabled, loading, busy, problem, unsupported, serverNotReady, toggle };
}
