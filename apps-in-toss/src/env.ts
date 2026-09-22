// 서버(주식 레이더 사이트) 주소 — 분석·스크리너 API 를 이 서버가 제공한다.
// Render 배포 주소가 다르면 여기 '한 곳만' 바꾼다 (아이콘 URL 은 granite.config.ts).
// 주의: 서버에 SITE_PASSWORD 가 설정돼 있으면 앱이 API 를 못 쓴다 — 공개 배포여야 한다.
export const API_BASE_URL = 'https://ma-radar.onrender.com';

// 사용자에게 보이는 문구가 참조하는 상수 — 서버 기본값과 맞춰 둔다.
// (서버: app/config.py lookback_years 기본 일 3년 · 주 7년 · 월 전체)
export const LOOKBACK_LABEL = '일봉 3년 · 주봉 7년 · 월봉 전체 기간 (최근 가중)';
export const SCREENER_RULE_LABEL =
  '3년 백테스트에서 지지 성공 3회 이상 · 지지 성공률 60% 이상인 검증된 선만';

export const BRAND_NAME = '원토피아';
export const CONTACT_EMAIL = 'wontopiaaa@gmail.com';
export const DISCLAIMER =
  '과거 데이터 통계이며 투자 권유가 아닙니다. 과거에 잘 지켜진 이평선이 미래에도 지켜진다는 보장은 없습니다.';

// 아침 시장 알림(스마트 발송) 템플릿 코드.
// 앱인토스 콘솔 > 미니앱 > 스마트 발송 에서 '기능성' 메시지를 만들고 문구
// 검수가 승인되면 코드가 나온다. 그 값을 여기에 넣으면 알림 기능이 켜진다.
// 비어 있는 동안에는 홈에 알림 카드가 아예 보이지 않는다 — 동의 화면을 열 수
// 없는 스위치를 내보내면 사용자에게도, 심사자에게도 고장으로 보인다.
export const PUSH_TEMPLATE_CODE = 'wontopia-ma-radar-morning-brief';

// 알림이 가는 시각. 서버의 크론(ma-radar/.github/workflows/morning-push.yml,
// '30 23 * * 1-5' UTC)과 **같은 값**이어야 한다 — 화면이 '아침'이라고만 말하면
// '켜 뒀는데 아직 안 온 아침'을 사용자가 고장으로 오해한다.
export const PUSH_TIME_LABEL = '평일 아침 8시 30분';

// 스크리너 갱신 시각(KST)은 여기에 두지 않는다.
//
// 그 값의 주인은 서버(DAILY_REFRESH_KST)이고, /api/today 가 refreshAtKst 로
// 내려준다. 앱이 숫자를 적어 두면 서버 설정을 바꾸는 순간 조용히 어긋나서,
// 홈 브리핑 카드와 관심종목 배지가 서로 다른 날짜를 말하게 된다.
// 쓸 일이 있으면 src/refreshDay.ts 의 refreshDayKey() / useRefreshDayKey() 를 쓴다.
