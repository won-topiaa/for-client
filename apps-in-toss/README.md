# 이평선 레이더 — 앱인토스 미니앱 (wontopia-ma-radar)

주식 레이더 사이트의 두 기능을 앱인토스(Apps in Toss) 미니앱으로 분리한 앱.

- **홈** (`/` 화면): 두 기능 안내와 이동평균선 설명, 문의처.
- **내 종목 이평선** (`/radar` 화면): 종목을 검색하면 일봉·주봉·월봉별로 그동안 가장 자주,
  믿을 만하게 지지/저항 역할을 해온 이동평균선 2~3개를 백테스트로 찾아 차트에 그려준다.
- **오늘의 지지선** (`/screener` 화면): 시장 전체(국내 거래대금 상위 · 미국 S&P500급)를
  매일 스캔해 '검증된 지지 이평선에 오늘 저가가 닿은' 종목만 보여준다.
- **관심종목** (`/watchlist` 화면): 위 두 화면에서 종목 오른쪽 위의 ☆ 로 담아 둔 목록.
  로그인이 없어 계정에 못 묶으므로 토스 `Storage` 에 **기기 로컬로** 저장한다
  (`src/watchlist.ts`). 기기를 바꾸면 목록은 따라가지 않는다.

> **앱에는 로그인이 없다.** 앱인토스는 토스 로그인 외의 자체 로그인을 금지하며, 이 때문에
> 1차 심사에서 반려됐다(2026-08). 그래서 앱은 계정 없이 공개 API 만 호출하고 개인정보를
> 수집하지 않는다. 사이트(`/touches`)는 그대로 이메일 회원제를 유지한다.

분석은 전부 **기존 사이트 서버**(`app/server.py`, Render 배포)가 수행하고, 이 앱은 그 API 를
호출해 화면만 네이티브로 그린다. 서버 주소는 `src/env.ts` 의 `API_BASE_URL` 한 곳에서 바꾼다.

> 차트는 서드파티 라이브러리 없이 순수 React Native View 로 그린다
> (`src/components/CandleChart.tsx`) — 미니앱 런타임에는 외부 네이티브 모듈이 보장되지 않기 때문.

## 실행 (개발은 무조건 샌드박스로)

```bash
cd apps-in-toss
npm install
npm run dev
```

1. 앱스토어에서 **"앱인토스 샌드박스"** 설치 (id6745618667, iOS 16+)
2. 맥과 폰을 **같은 Wi-Fi**(핫스팟 X)에 두고, `ifconfig | grep "inet "` 으로 맥 IP 확인
3. 샌드박스 앱에서 '로컬 네트워크' 권한 허용 → 서버 주소에 맥 IP 입력
4. `intoss://wontopia-ma-radar` 로 열기
5. 오류는 dev 서버 창에서 `j` 를 눌러 DevTools 콘솔로 본다 — **흰 화면이면 번들을 뒤지지 말고
   먼저 샌드박스 콘솔의 오류부터 읽는다**

## 배포

```bash
npm run build      # = ait build (.ait 산출물 생성 — granite build 아님)
npx ait token add --api-key <발급키> [프로필]   # 키 교체 시엔 token remove 먼저
npm run deploy     # = ait deploy
```

- `ait` 는 전역 명령이 아니다 — 반드시 `npx ait`
- 저장된 프로필이 `--api-key` 보다 우선이다. 키를 바꿀 땐 `npx ait token remove` 먼저
- `granite.config.ts` 에 **`target` 을 적지 않는다** (적으면 두 런타임 번들이 같아짐)
- 토스 앱 최소 버전: Android 5.220.0 / iOS 5.221.0 (미만이면 앱이 안 그려짐 — 샌드박스는 통과됨)

## 스토어 등록 정보

| 항목 | 값 |
|---|---|
| 앱 이름(appName) | `wontopia-ma-radar` — 개발자센터 콘솔에 등록한 이름과 같아야 함 |
| 표시 이름 | 이평선 레이더 |
| 사업자 | 원토피아 |
| 문의 이메일 | wontopiaaa@gmail.com |
| 아이콘 | `https://<사이트주소>/static/icon.png` — **파일 경로가 아니라 이미지 URL** (재생성: `python apps-in-toss/scripts/make_icon.py`) |
| 개인정보처리방침 | `https://<사이트주소>/privacy` |
| 스크린샷 | 세로 636×1048 **최소 3장**, 가로 1504×741 **최소 1장** (규격 밖은 안 세어짐) — `store/` 에 준비됨, 재생성은 아래 |
| 약관 체크박스 | **2개 모두** 체크 (하단 것을 빠뜨리기 쉬움) |

투자 정보 앱이므로 화면 하단마다 면책 문구(투자 권유 아님)를 상시 노출한다 (`src/components/ui.tsx` 의 `Footer`).

### 스토어 스크린샷 재생성

스크린샷은 손으로 그리지 않는다 — 앱의 팔레트(`src/theme.ts`)·문구(`src/env.ts`)·포맷
함수(`src/format.ts`)를 그대로 import 하고, 수치는 백테스트 엔진의 실제 출력에서 뽑는다.

```bash
# 저장소 루트에서 (엔진 데이터 추출 → PNG 5장: 세로 4장 + 가로 1장)
python apps-in-toss/scripts/store_screenshot_data.py
node apps-in-toss/scripts/make_store_screenshots.mjs   # → apps-in-toss/store/*.png
```

**제출 전 반드시 실데이터로 재생성할 것** — 외부 시세가 막힌 환경에서는 sample(합성)
데이터로 떨어진다 (`scripts/store/data.json` 의 `provider` 가 `sample` 이면 제출용 아님).
본인 컴퓨터에서 위 두 명령을 그대로 실행하면 무료 실시세(FDR/네이버)로 다시 뽑힌다.
Chromium 경로는 `CHROMIUM_PATH` 환경변수로 지정 가능(맥은 설치된 Chrome 자동 사용).

## 서버 쪽 전제

- 서버는 `SITE_PASSWORD` 없이 **공개 배포**여야 앱이 API 를 쓸 수 있다.
- 앱이 쓰는 API 는 전부 인증이 필요 없다 — `/api/search`, `/api/analyze`, `/api/touches`.
  (`/api/touches` 는 앱을 위해 공개로 바뀌었다. 사이트의 `/touches` **페이지**는 여전히
  회원 전용이라 웹 가입 동선은 그대로다.)
- 서버의 `client:"app"` Bearer 토큰 인증은 남아 있지만 **앱은 더 이상 쓰지 않는다.**

## 체크리스트 (새로 만질 때)

```
[ ] 루트 index.ts / src/pages 재노출용 pages/ / pages/_404.tsx 가 있다  ← 없으면 흰 화면
[ ] babel.config.js / react-native.config.js 가 있다
[ ] react-native 0.84.0 / react 19.2.3 / @types/react 19.2.x
[ ] @granite-js/* 는 최신 유지 (마이그레이션 표의 1.0.18 로 내리지 않기)
[ ] granite.config.ts 에 target 을 적지 않았다
[ ] 첫 실행은 배포가 아니라 샌드박스로 한다
[ ] 스토어 스크린샷은 손으로 그리지 말고 앱의 상수·포맷 함수를 그대로 써서 만든다
```
