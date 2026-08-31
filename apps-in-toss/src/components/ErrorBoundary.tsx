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
  /** 같은 오류의 연속 재시도 횟수 — 반복되면 안내를 바꾼다 */
  retries: number;
  /** 직전에 잡은 오류 메시지. 다른 오류면 횟수를 초기화하는 기준. */
  lastMessage: string | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, retries: 0, lastMessage: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // 미니앱에는 콘솔이 없다시피 하지만, 개발 중에는 여기서 원인을 본다
    console.error('[이평선 레이더] 화면 렌더 실패:', error);
    // 다른 오류면 재시도 횟수를 초기화한다. 안 그러면 한 번 2회에 도달한 뒤로는
    // 전혀 무관한 오류에도 "앱을 완전히 닫으세요" 가 계속 뜬다 — 한 번만 다시
    // 시도하면 풀릴 상황인데도.
    const msg = String(error?.message ?? error);
    this.setState((s) => (s.lastMessage === msg ? null : { retries: 0, lastMessage: msg }));
  }

  render() {
    const { error, retries } = this.state;
    if (!error) {
      return this.props.children;
    }
    // 이 경계는 라우터보다 바깥에 있다(프레임워크가 Container 를 라우터 위에
    // 둔다). 그래서 '다시 시도'는 화면 하나가 아니라 앱 트리 전체를 다시
    // 마운트하고, 사용자가 보던 화면이 아니라 시작 화면으로 돌아간다.
    // 같은 오류가 또 나면 재시도로는 못 벗어나므로 안내를 바꾼다.
    const stuck = retries >= 2;
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
            {stuck
              ? '같은 문제가 반복되고 있어요. 앱을 완전히 닫았다가 다시 열어 주세요. ' +
                '그래도 같으면 아래 이메일로 알려주시면 빠르게 고치겠습니다.'
              : '일시적인 문제일 수 있어요. 아래 버튼을 누르면 처음 화면부터 다시 시작합니다.'}
          </Text>
          <TouchableOpacity
            onPress={() => this.setState((s) => ({ error: null, retries: s.retries + 1 }))}
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
