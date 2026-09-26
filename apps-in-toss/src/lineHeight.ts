/**
 * 줄 간격(lineHeight)을 주는 Text 에는 `...lh(N)` 을 쓴다 — `lineHeight: N` 을 직접 쓰지 않는다.
 *
 * iOS 새 아키텍처(Fabric, 토스 RN 0.84 호스트)에서 Yoga 가 3x 화면의 픽셀 맞춤을 float 로 하다가
 * 글 상자 높이를 N줄×lineHeight 보다 0.0001pt 쯤 작게 만들면, TextKit 이 다 들어가지 않는 마지막
 * 줄을 통째로 그리지 않는다(실기기: 사진 분석 안내문 4번째 줄이 비어 보였다 —
 * react/react-native#57920, 고침 react/yoga#2011 은 아직 안 들어갔다). 글이 화면의 어디에 놓이느냐에
 * 따라 생겨서 웹 미리보기로는 안 보인다.
 *
 * 픽셀에 맞지 않는 0.1pt 아래 여백이 상자 높이를 '소수'로 만들어 Yoga 가 글 상자 아래 모서리를
 * 올림하게 한다 → 늘 1px 여유가 생긴다. 줄 간격·줄바꿈·글자 위치는 그대로다.
 * 0.1 대신 1/3·0.5·hairlineWidth 처럼 픽셀에 맞는 값은 쓰지 말 것. 바깥 Text 에 둔다(안쪽 Text 의 padding 은 무시된다).
 * 같은 스타일에 paddingBottom/paddingVertical/padding 이 있으면 그 값에 0.1 을 더해 쓴다.
 */
export const lh = (lineHeight: number) => ({ lineHeight, paddingBottom: 0.1 }) as const;
