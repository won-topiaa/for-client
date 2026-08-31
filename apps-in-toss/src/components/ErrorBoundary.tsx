import React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { BRAND_NAME, CONTACT_EMAIL } from '../env';

// 렌더 중 예외 하나가 앱 전체를 흰 화면으로 만드는 것을 막는다.
// RN 에는 브라우저의 '깨진 화면이라도 남는' 안전망이 없어서, 잡지 않으면
// 루트가 통째로 언마운트되고 사용자는 아무것도 없는 화면을 본다.
//
// 서버 응답의 필드가 말없이 바뀌면(저장소가 둘이라 실제로 그런 적이 있다)
// 숫자 포맷팅에서 TypeError 가 나기 쉬운데, 그 한 번이 앱을 죽이면 안 된다.

interface Props {
  children: React.ReactNode;
  /** 팔레트를 못 쓰는 최상위에서도 동작해야 하므로 색은 고정값으로 받는다 */
  dark?: boolean;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // 미니앱에는 콘솔이 없다시피 하지만, 개발 중에는 여기서 원인을 본다
    console.error('[이평선 레이더] 화면 렌더 실패:', error);
  }

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    const dark = !!this.props.dark;
    const bg = dark ? '#09090b' : '#fafafa';
    const card = dark ? '#18181b' : '#ffffff';
    const border = dark ? '#27272a' : '#e4e4e7';
    const text = dark ? '#f4f4f5' : '#18181b';
    const sub = dark ? '#a1a1aa' : '#52525b';
    const accent = dark ? '#34d399' : '#059669';

    return (
      <ScrollView style={{ flex: 1, backgroundColor: bg }} contentContainerStyle={{ padding: 16 }}>
        <View
          style={{
            backgroundColor: card,
            borderWidth: 1,
            borderColor: border,
            borderRadius: 12,
            padding: 16,
            gap: 10,
            marginTop: 24,
          }}
        >
          <Text style={{ fontSize: 17, fontWeight: '800', color: text }}>
            화면을 그리지 못했어요
          </Text>
          <Text style={{ fontSize: 13, color: sub, lineHeight: 20 }}>
            일시적인 문제일 수 있어요. 아래 버튼으로 다시 시도해 보시고, 계속 같은
            화면이 나오면 알려주시면 빠르게 고치겠습니다.
          </Text>
          <TouchableOpacity
            onPress={() => this.setState({ error: null })}
            accessibilityRole="button"
            style={{
              backgroundColor: accent,
              borderRadius: 10,
              paddingVertical: 12,
              alignItems: 'center',
              marginTop: 2,
            }}
          >
            <Text style={{ color: '#ffffff', fontSize: 15, fontWeight: '700' }}>다시 시도</Text>
          </TouchableOpacity>
          <Text style={{ fontSize: 11, color: sub, marginTop: 6 }}>
            {BRAND_NAME} · 문의 {CONTACT_EMAIL}
          </Text>
          <Text style={{ fontSize: 10, color: sub, marginTop: 2 }} numberOfLines={3}>
            {String(error?.message ?? error)}
          </Text>
        </View>
      </ScrollView>
    );
  }
}
