import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import type { Palette } from '../theme';

// 화면 하단 고정 탭바.
//
// 왜 컴포넌트로 직접 그리는가: 미니앱 라우팅은 파일 기반 createRoute 라
// 탭 네비게이터가 따로 없다. 그래서 각 화면이 이 바를 자기 바닥에 놓고,
// 누르면 navigate 한다 — 사용자에게는 탭바와 똑같이 동작한다.
//
// 토스와 맞춘 것: 선택한 탭은 검정에 가까운 회색(gray900), 나머지는 흐린
// 회색(gray400). 토스 앱 하단 탭도 파랑이 아니라 이 흑/회 대비를 쓴다.
//
// 아이콘을 이모지에서 도형으로 바꾼 이유: 이모지는 기기마다 그림과 색이
// 다르고, 선택 상태에 따라 색을 바꿀 수 없어 '지금 어느 탭인지'가 글자로만
// 드러났다. View 몇 개로 그리면 색이 상태를 따라오고 두께도 일정하다.
// (SVG 를 쓰지 않는 이유는 CandleChart 와 같다 — 미니앱 런타임에 서드파티
//  네이티브 모듈이 보장되지 않는다.)

export const TAB_BAR_HEIGHT = 58;
/** 각 화면의 contentContainerStyle 바닥 여백 — 마지막 내용이 바에 가리지 않게. */
export const TAB_BAR_SPACER = TAB_BAR_HEIGHT + 16;

export type TabKey = '/' | '/radar' | '/screener' | '/patterns' | '/watchlist';

const ICON_BOX = { width: 22, height: 20 } as const;

/** 집 — 지붕(테두리 삼각형) + 몸통 */
function IconHome({ color }: { color: string }) {
  return (
    <View style={{ ...ICON_BOX, alignItems: 'center', justifyContent: 'center' }}>
      <View
        style={{
          width: 0,
          height: 0,
          borderLeftWidth: 11,
          borderRightWidth: 11,
          borderBottomWidth: 9,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
          borderBottomColor: color,
        }}
      />
      <View
        style={{
          width: 15,
          height: 10,
          borderBottomLeftRadius: 2,
          borderBottomRightRadius: 2,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

/** 막대 3개 — 종목 분석(이평선) */
function IconBars({ color }: { color: string }) {
  return (
    <View style={{ ...ICON_BOX, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 3 }}>
      <View style={{ width: 4, height: 9, borderRadius: 2, backgroundColor: color }} />
      <View style={{ width: 4, height: 14, borderRadius: 2, backgroundColor: color }} />
      <View style={{ width: 4, height: 19, borderRadius: 2, backgroundColor: color }} />
    </View>
  );
}

/** 선 위에 닿은 점 — 오늘의 지지선 */
function IconSupport({ color }: { color: string }) {
  return (
    <View style={{ ...ICON_BOX, alignItems: 'center', justifyContent: 'flex-end' }}>
      <View
        style={{ width: 9, height: 9, borderRadius: 4.5, backgroundColor: color, marginBottom: 3 }}
      />
      <View style={{ width: 22, height: 3, borderRadius: 1.5, backgroundColor: color }} />
    </View>
  );
}

/** 오른쪽으로 모이는 두 선 — 차트 패턴(삼각수렴) */
function IconWedge({ color }: { color: string }) {
  const bar = {
    position: 'absolute' as const,
    left: 1,
    width: 20,
    height: 2.5,
    borderRadius: 1.25,
    backgroundColor: color,
  };
  return (
    <View style={{ ...ICON_BOX, justifyContent: 'center' }}>
      <View style={[bar, { top: 3, transform: [{ rotate: '13deg' }] }]} />
      <View style={[bar, { bottom: 3, transform: [{ rotate: '-13deg' }] }]} />
    </View>
  );
}

/** 별 — 관심종목. 목록의 ★ 버튼과 같은 글리프라 뜻이 바로 이어진다. */
function IconStar({ color }: { color: string }) {
  return (
    <View style={{ ...ICON_BOX, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontSize: 19, lineHeight: 21, color }}>★</Text>
    </View>
  );
}

const TABS: { key: TabKey; label: string; Icon: (props: { color: string }) => React.ReactElement }[] =
  [
    { key: '/', label: '홈', Icon: IconHome },
    { key: '/radar', label: '이평선', Icon: IconBars },
    { key: '/screener', label: '지지선', Icon: IconSupport },
    { key: '/patterns', label: '패턴', Icon: IconWedge },
    { key: '/watchlist', label: '관심', Icon: IconStar },
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
      {TABS.map(({ key, label, Icon }) => {
        const active = key === current;
        const color = active ? p.text : p.disabled;
        return (
          <TouchableOpacity
            key={key}
            // 현재 탭을 다시 누르면 아무것도 하지 않는다 — 같은 화면을
            // 쌓아 올려 뒤로가기가 이상해지는 것을 막는다.
            onPress={() => {
              if (!active) {
                onNavigate(key);
              }
            }}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected: active }}
            activeOpacity={0.6}
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
              paddingVertical: 6,
            }}
          >
            <Icon color={color} />
            <Text
              style={{ fontSize: 11, fontWeight: active ? '700' : '500', color }}
              numberOfLines={1}
            >
              {label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}
