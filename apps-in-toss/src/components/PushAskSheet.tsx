import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { PUSH_TIME_LABEL } from '../env';
import type { Palette } from '../theme';

// 결과 화면 맨 아래 '아침 시장 알림 받기'를 눌렀을 때 뜨는 바텀시트.
//
// 경쟁 앱이 분석 결과 위에 알림 신청 시트를 띄우는 방식을 가져왔다. 다만 저절로 띄우지는
// 않는다 — 앱인토스 체크리스트 '화면 전환 시 바텀시트로 행동을 강제 유도하지 않아요'.
// 보내는 것은 승인된 아침 알림(템플릿 wontopia-ma-radar-morning-brief)과 같은 것뿐이다.
// '동의하고 알림받기'는 알림 화면의 스위치와 같은 흐름(토스 SDK 동의 → 구독)을 탄다.
// 리텐션 문구('놓치지 않도록', '매일')는 쓰지 않는다 — 기능성 알림으로만 보낸다.

export function PushAskSheet({
  palette: p,
  busy,
  problem,
  onAgree,
  onLater,
}: {
  palette: Palette;
  busy: boolean;
  problem: string | null;
  onAgree: () => void;
  onLater: () => void;
}) {
  return (
    <View
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.45)',
        justifyContent: 'flex-end',
      }}
    >
      {/* 바깥을 눌러도 닫힌다 */}
      <TouchableOpacity
        onPress={onLater}
        accessibilityLabel="닫기"
        activeOpacity={1}
        style={{ flex: 1 }}
      />
      <View
        accessibilityViewIsModal
        style={{
          backgroundColor: p.card,
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          paddingHorizontal: 24,
          paddingTop: 28,
          paddingBottom: 32,
          gap: 16,
        }}
      >
        <View style={{ gap: 6 }}>
          <Text accessibilityRole="header" style={{ fontSize: 22, fontWeight: '800', color: p.text }}>
            전날 미국 시장을 한 줄로 보내 드릴까요?
          </Text>
          <Text style={{ fontSize: 15, color: p.sub, lineHeight: 22 }}>{PUSH_TIME_LABEL}에 보내 드려요</Text>
        </View>
        {/* 실제로 오는 알림의 모양 */}
        <View
          style={{
            flexDirection: 'row',
            gap: 12,
            alignItems: 'center',
            backgroundColor: p.sunken,
            borderRadius: 16,
            padding: 16,
          }}
        >
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              backgroundColor: p.primaryBg,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 20 }}>🔔</Text>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: p.text }}>아침 시장 알림</Text>
            <Text style={{ fontSize: 14, color: p.sub, lineHeight: 20 }}>나스닥 +0.48% 공포탐욕 55 중립이에요.</Text>
          </View>
        </View>
        <Text style={{ fontSize: 12.5, color: p.faint, lineHeight: 18 }}>
          예시 문구예요. 공포탐욕은 미국 CNN이 발표하는 시장 심리 지수(0~100)이고, ‘중립’은 CNN이 붙인 구간
          이름이에요. 알림은 홈의 ‘아침 시장 알림’에서 언제든 끌 수 있어요.
        </Text>
        {problem ? <Text style={{ fontSize: 13.5, color: p.danger, lineHeight: 20 }}>{problem}</Text> : null}
        <TouchableOpacity
          onPress={onAgree}
          disabled={busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy, busy }}
          activeOpacity={0.8}
          style={{
            backgroundColor: p.primaryFill,
            opacity: busy ? 0.6 : 1,
            borderRadius: 16,
            paddingVertical: 16,
            alignItems: 'center',
          }}
        >
          <Text style={{ fontSize: 16, fontWeight: '700', color: p.onPrimary }}>
            {busy ? '처리 중…' : '동의하고 알림 받기'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onLater} accessibilityRole="button" activeOpacity={0.6} style={{ alignItems: 'center', paddingVertical: 4 }}>
          <Text style={{ fontSize: 15, color: p.sub }}>나중에</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
