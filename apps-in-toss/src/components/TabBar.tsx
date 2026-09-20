import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import type { Palette } from '../theme';

// 화면 하단 고정 탭바.
//
// 왜 컴포넌트로 직접 그리는가: 미니앱 라우팅은 파일 기반 createRoute 라
// 탭 네비게이터가 따로 없다. 그래서 각 화면이 이 바를 자기 바닥에 놓고,
// 누르면 navigate 한다 — 사용자에게는 탭바와 똑같이 동작한다.
//
// 도입 이유: 이전에는 기능 간 이동이 '홈으로 갔다가 다시 들어가기' 뿐이라,
// 레이더↔지지선처럼 자주 오가는 동선이 매번 두 번 눌러야 했다.

export const TAB_BAR_HEIGHT = 58;
/** 각 화면의 contentContainerStyle 바닥 여백 — 마지막 내용이 바에 가리지 않게. */
export const TAB_BAR_SPACER = TAB_BAR_HEIGHT + 12;

export type TabKey = '/' | '/radar' | '/screener' | '/patterns' | '/watchlist';

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: '/', label: '홈', icon: '⌂' },
  { key: '/radar', label: '이평선', icon: '📊' },
  { key: '/screener', label: '지지선', icon: '📍' },
  { key: '/patterns', label: '패턴', icon: '📐' },
  { key: '/watchlist', label: '관심', icon: '★' },
];

export function TabBar({
  current,
  palette: p,
  onNavigate,
}: {
  current: TabKey;
  palette: Palette;
  /** navigation.navigate 를 그대로 넘긴다 (화면마다 Route 가 달라서 주입받는다). */
  onNavigate: (to: TabKey) => void;
}) {
  return (
    <View
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: TAB_BAR_HEIGHT,
        flexDirection: 'row',
        borderTopWidth: 1,
        borderTopColor: p.border,
        backgroundColor: p.card,
      }}
    >
      {TABS.map((t) => {
        const active = t.key === current;
        return (
          <TouchableOpacity
            key={t.key}
            // 현재 탭을 다시 누르면 아무것도 하지 않는다 — 같은 화면을
            // 쌓아 올려 뒤로가기가 이상해지는 것을 막는다.
            onPress={() => {
              if (!active) {
                onNavigate(t.key);
              }
            }}
            accessibilityRole="button"
            accessibilityLabel={t.label}
            accessibilityState={{ selected: active }}
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
              paddingVertical: 6,
            }}
          >
            <Text style={{ fontSize: 15, color: active ? p.indigo : p.faint }}>{t.icon}</Text>
            <Text
              style={{
                fontSize: 10,
                fontWeight: active ? '800' : '500',
                color: active ? p.indigo : p.faint,
              }}
              numberOfLines={1}
            >
              {t.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}
