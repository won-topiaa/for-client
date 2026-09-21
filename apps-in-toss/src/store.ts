// 화면 사이 값 전달 (스크리너 카드 → 레이더 자동 분석).
// 라우트 파라미터 대신 모듈 상태를 쓴다 — 레이더('/radar')는 이미 스택에 있어
// 파라미터 전달이 화면 재생성에 좌우되기 때문. 레이더 화면이 포커스될 때 읽고 비운다.
export const pendingAnalyze: { symbol: string | null } = { symbol: null };

// 마지막 분석 결과 — 화면을 떠났다 돌아왔을 때 즉시 되살리기 위한 것.
//
// 하단 탭바가 생기면서 '이평선 ↔ 지지선'을 오가는 일이 잦아졌다. 돌아올 때마다
// 같은 종목을 다시 분석하면 서버에서 1.2초를 또 기다려야 하고(실측), 사용자는
// 아무것도 안 했는데 화면이 비어 있는 것처럼 보인다. 같은 세션에서 방금 본
// 결과를 그대로 다시 그려 준다 — 새로 보고 싶으면 '분석'을 다시 누르면 된다.
//
// 앱을 껐다 켜면 사라진다(메모리). 디스크에 남기지 않는 이유는, 하루가 지나면
// 낡은 분석이 되는데 그걸 되살려 보여 주는 편이 더 나쁘기 때문이다.
export interface LastAnalysis {
  symbol: string;
  /** 표시용 종목 정보 (이름·시장) — 분석 응답에는 이름이 없다. */
  info: { symbol: string; name: string; market?: string | null };
  /** analyzeSymbol 응답 그대로. */
  body: unknown;
}

export const lastAnalysis: { value: LastAnalysis | null } = { value: null };
