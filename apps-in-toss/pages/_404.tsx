import React from 'react';
import { Text, View } from 'react-native';

// 이 파일이 없으면 granite 라우터가 첫 렌더에서 무조건 예외를 던져
// 앱이 흰 화면으로 죽는다. 화면이 하나뿐이어도 반드시 둔다.
export default function NotFoundPage() {
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <Text style={{ fontSize: 40, marginBottom: 12 }}>📉</Text>
      <Text style={{ fontSize: 16, fontWeight: '700', marginBottom: 4 }}>페이지를 찾을 수 없어요</Text>
      <Text style={{ fontSize: 13, color: '#71717a', textAlign: 'center' }}>
        주소가 바뀌었거나 없는 화면이에요. 뒤로 가기로 돌아가 주세요.
      </Text>
    </View>
  );
}
