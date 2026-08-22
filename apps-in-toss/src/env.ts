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
