import { Analytics } from '@apps-in-toss/framework';
import React from 'react';

// 사용자의 '주요 행동' 기록 — 앱인토스 노출 정책의 실사용 지표(전환율) 산정에 쓰인다.
//
// 콘솔에서 전환 지표를 고를 때 여기 적힌 log_name 이 후보로 뜬다. 이름을 바꾸면
// 콘솔에 등록해 둔 지표와 끊기므로, 한번 올린 이름은 바꾸지 않는다.
//
// 안전성: 프레임워크가 로거를 붙이기 전이거나 로깅을 끈 환경에서는 내부적으로
// noop 로거가 쓰인다. 그래서 이 래퍼가 버튼 동작을 막거나 예외를 내지 않는다.
// (Analytics.Press 는 자식의 onPress 를 감싸 원래 핸들러를 그대로 호출한다.)

/** 콘솔 전환 지표로 쓸 이름. 새로 만들 때만 늘리고, 기존 값은 유지한다. */
export const LOG = {
  /** 종목 분석을 시작함 — 이 앱의 핵심 행동 */
  analyze: 'ma_analyze',
  /** 관심종목에 담음 — 다시 찾아올 이유를 만든 행동 */
  watchlistAdd: 'watchlist_add',
  /** 아침 알림을 켬 */
  pushEnable: 'push_enable',
  /** 홈에서 기능으로 이동 */
  openFeature: 'open_feature',
  /** 차트 사진으로 분석을 요청함 (1.3.5) */
  photoAnalyze: 'photo_analyze',
  // ── 사진 분석 결과 화면에서 무엇을 여는지 (2026-09-26 토론: '측정으로 논쟁을 끝낸다') ──
  // (?) 뜻풀이·질문을 많이 열면 초보 비중이, '자세히 보기'를 많이 열면 중급자 비중이 높다는 신호.
  /** 지표 행의 (?) 뜻풀이를 펼침 — text 에 지표 이름 */
  photoHelp: 'photo_help_open',
  /** 자주 묻는 질문을 펼침 — text 에 질문 */
  photoFaq: 'photo_faq_open',
  /** '자세히 보기 · 지표 원문'을 펼침 */
  photoDetail: 'photo_detail_open',
  /** 결과를 공유함 */
  photoShare: 'photo_share',
  /** 결과를 본 뒤 다른 차트도 분석하기 */
  photoAgain: 'photo_again',
} as const;

/**
 * 버튼 하나의 클릭을 기록한다. 자식은 반드시 React 엘리먼트 **하나**여야 하고,
 * ref 를 받을 수 있어야 한다(= TouchableOpacity 같은 기본 컴포넌트).
 * 직접 만든 함수 컴포넌트를 감싸면 ref 경고가 나므로, 감싸는 위치는 항상
 * components/ui.tsx 안쪽의 TouchableOpacity 다.
 */
export function Track({
  name,
  text,
  enabled = true,
  children,
}: {
  name: string;
  /** 어떤 버튼이었는지 — 같은 log_name 이 여러 화면에 있을 때 구분용 */
  text?: string;
  enabled?: boolean;
  children: React.ReactElement;
}) {
  return (
    <Analytics.Press enabled={enabled} params={{ log_name: name, ...(text ? { text } : null) }}>
      {children}
    </Analytics.Press>
  );
}

/**
 * logName 이 있을 때만 기록을 붙이고, 없으면 자식을 그대로 돌려준다.
 * (공용 버튼 컴포넌트가 매번 조건문을 쓰지 않게)
 */
export function maybeTrack(
  logName: string | undefined,
  logText: string | undefined,
  enabled: boolean,
  child: React.ReactElement,
): React.ReactElement {
  if (!logName) {
    return child;
  }
  return (
    <Track name={logName} text={logText} enabled={enabled}>
      {child}
    </Track>
  );
}
