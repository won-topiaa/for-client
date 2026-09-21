import { AppsInToss } from '@apps-in-toss/framework';
import type { InitialProps } from '@granite-js/react-native';
import React, { type PropsWithChildren } from 'react';
import { context } from '../require.context';
import { ErrorBoundary } from './components/ErrorBoundary';
import { usePalette } from './theme';

// 모든 화면을 에러 바운더리로 감싼다. 없으면 렌더 중 예외 하나에 루트가 통째로
// 언마운트돼 앱이 흰 화면이 된다 (RN 에는 브라우저 같은 안전망이 없다).
//
// 팔레트를 여기서 읽어 넘기는 이유: 에러 바운더리는 클래스 컴포넌트라 훅을
// 못 쓴다. 넘겨주지 않으면 다크 모드에서 오류 화면만 흰 종이로 튄다.
function AppContainer({ children }: PropsWithChildren<InitialProps>) {
  const palette = usePalette();
  return <ErrorBoundary palette={palette}>{children}</ErrorBoundary>;
}

export default AppsInToss.registerApp(AppContainer, {
  context,
});
