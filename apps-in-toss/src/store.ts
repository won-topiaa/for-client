// 화면 사이 값 전달 (스크리너 카드 → 레이더 자동 분석).
// 라우트 파라미터 대신 모듈 상태를 쓴다 — 레이더('/radar')는 이미 스택에 있어
// 파라미터 전달이 화면 재생성에 좌우되기 때문. 레이더 화면이 포커스될 때 읽고 비운다.
export const pendingAnalyze: { symbol: string | null } = { symbol: null };
