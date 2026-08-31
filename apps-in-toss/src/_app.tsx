import { AppsInToss } from '@apps-in-toss/framework';
import type { InitialProps } from '@granite-js/react-native';
import React, { type PropsWithChildren } from 'react';
import { useColorScheme } from 'react-native';
import { context } from '../require.context';
import { ErrorBoundary } from './components/ErrorBoundary';

// 모든 화면을 에러 바운더리로 감싼다. 없으면 렌더 중 예외 하나에 루트가 통째로
// 언마운트돼 앱이 흰 화면이 된다 (RN 에는 브라우저 같은 안전망이 없다).
function AppContainer({ children }: PropsWithChildren<InitialProps>) {
  const dark = useColorScheme() === 'dark';
  return <ErrorBoundary dark={dark}>{children}</ErrorBoundary>;
}

export default AppsInToss.registerApp(AppContainer, {
  context,
});
