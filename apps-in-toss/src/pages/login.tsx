import { createRoute } from '@granite-js/react-native';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { login, signup } from '../api/client';
import { Card, Chip, Footer, PrimaryButton } from '../components/ui';
import { usePalette } from '../theme';

export const Route = createRoute('/login', {
  component: LoginPage,
});

function LoginPage() {
  const p = usePalette();
  const navigation = Route.useNavigation();

  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false); // 가입 시 개인정보 동의 (웹과 동일 요건)
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const submit = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setErrorMsg('');
    try {
      if (mode === 'login') {
        await login(email.trim(), password);
      } else {
        await signup(email.trim(), password);
      }
      navigation.goBack(); // 스크리너로 복귀 — 포커스 이벤트가 재조회한다
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '요청에 실패했어요.');
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = {
    borderWidth: 1,
    borderColor: p.border,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    fontSize: 15,
    color: p.text,
  } as const;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: p.bg }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={{ fontSize: 22, fontWeight: '800', color: p.text }}>🔐 로그인</Text>
      <Text style={{ fontSize: 12, color: p.sub, lineHeight: 18 }}>
        '오늘의 지지선 터치'는 회원 전용(무료)이에요. 주식 레이더 사이트와 같은 계정을 씁니다.
      </Text>

      <Card palette={p} style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <Chip label="로그인" active={mode === 'login'} palette={p} onPress={() => setMode('login')} />
          <Chip label="회원가입" active={mode === 'signup'} palette={p} onPress={() => setMode('signup')} />
        </View>
        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder="이메일"
          placeholderTextColor={p.faint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          style={inputStyle}
        />
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder={mode === 'signup' ? '비밀번호 (8자 이상)' : '비밀번호'}
          placeholderTextColor={p.faint}
          secureTextEntry
          autoCapitalize="none"
          style={inputStyle}
        />
        {mode === 'signup' ? (
          <TouchableOpacity
            onPress={() => setConsent(!consent)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: consent }}
            style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}
          >
            <View
              style={{
                width: 18,
                height: 18,
                borderRadius: 4,
                borderWidth: 1.5,
                marginTop: 1,
                borderColor: consent ? p.up : p.border,
                backgroundColor: consent ? p.up : 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {consent ? <Text style={{ color: '#ffffff', fontSize: 12, fontWeight: '700' }}>✓</Text> : null}
            </View>
            <Text style={{ flex: 1, fontSize: 12, color: p.sub, lineHeight: 17 }}>
              개인정보처리방침에 동의합니다. 이메일과 비밀번호(암호화 저장)만 수집해요.
            </Text>
          </TouchableOpacity>
        ) : null}
        {errorMsg ? <Text style={{ fontSize: 12, color: p.down }}>{errorMsg}</Text> : null}
        {busy ? (
          <ActivityIndicator color={p.up} />
        ) : (
          <PrimaryButton
            label={mode === 'login' ? '로그인' : '가입하고 시작하기'}
            disabled={!email.trim() || !password || (mode === 'signup' && !consent)}
            palette={p}
            onPress={() => void submit()}
          />
        )}
        <Text style={{ fontSize: 11, color: p.faint, lineHeight: 16 }}>
          가입 시 이메일과 비밀번호(암호화 저장)만 수집합니다. 개인정보처리방침은 주식 레이더 사이트
          하단에서 볼 수 있어요.
        </Text>
      </Card>

      <Footer palette={p} />
    </ScrollView>
  );
}
