import { appsInToss } from '@apps-in-toss/framework/plugins';
import { hermes } from '@granite-js/plugin-hermes';
import { router } from '@granite-js/plugin-router';
import { defineConfig } from '@granite-js/react-native/config';

// 주의: target 은 적지 않는다 — 적으면 0.84 번들까지 0.72 호환 변환을 받아
// 두 런타임 번들이 같아진다. 비워 두면 기본값(0.84.0)으로 올바르게 나뉜다.
export default defineConfig({
  // 개발자센터(콘솔)에 등록한 앱 이름과 같아야 한다. intoss://wontopia-ma-radar 로 열린다.
  appName: 'wontopia-ma-radar',
  scheme: 'intoss',
  plugins: [
    router(),
    hermes(),
    appsInToss({
      brand: {
        displayName: '이평선 레이더', // 토스 앱 목록/상단바에 보이는 이름
        primaryColor: '#059669', // 사이트 공통 에메랄드
        // 아이콘은 파일 경로가 아니라 '이미지 주소(URL)' — 프레임워크가 그대로
        // <Image source={{ uri }} /> 에 넘긴다. 사이트가 서빙하는 아이콘을 쓴다.
        icon: 'https://ma-radar.onrender.com/static/icon.png',
      },
      permissions: [],
    }),
  ],
});
