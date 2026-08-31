import React, { useState, type PropsWithChildren } from 'react';
import { Text, TouchableOpacity, View, type ViewStyle } from 'react-native';
import { BRAND_NAME, CONTACT_EMAIL, DISCLAIMER } from '../env';
import type { Palette } from '../theme';

// 페이지 공용 소형 UI — 카드/칩/버튼/접이식 설명/면책 문구

export function Card({
  palette: p,
  style,
  children,
}: PropsWithChildren<{ palette: Palette; style?: ViewStyle }>) {
  return (
    <View
      style={[
        {
          backgroundColor: p.card,
          borderWidth: 1,
          borderColor: p.border,
          borderRadius: 12,
          padding: 14,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Chip({
  label,
  active,
  palette: p,
  onPress,
}: {
  label: string;
  active?: boolean;
  palette: Palette;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      style={{
        paddingVertical: 7,
        paddingHorizontal: 12,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? p.up : p.border,
        backgroundColor: active ? p.emeraldBg : p.card,
      }}
    >
      <Text style={{ fontSize: 13, color: active ? p.up : p.text, fontWeight: active ? '700' : '400' }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

export function PrimaryButton({
  label,
  disabled,
  palette: p,
  onPress,
  /** 버튼 색. 기본은 상승/주요색(초록) — '오늘의 지지선' 처럼 카드 강조색이
   *  다른 곳에서 그 색을 그대로 쓰라고 열어 둔다. */
  color,
}: {
  label: string;
  disabled?: boolean;
  palette: Palette;
  onPress: () => void;
  color?: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={{
        backgroundColor: disabled ? p.border : (color ?? p.up),
        borderRadius: 10,
        paddingVertical: 13,
        alignItems: 'center',
      }}
    >
      <Text style={{ color: disabled ? p.faint : '#ffffff', fontSize: 15, fontWeight: '700' }}>{label}</Text>
    </TouchableOpacity>
  );
}

// 설명 문구는 기본으로 접어 둔다 — 작은 폰 화면에서 본문(차트·카드)이 먼저
// 보이도록. 면책 문구(Footer)는 예외로 항상 노출한다(투자 정보 앱 고지 의무).
export function Expandable({
  title,
  palette: p,
  initiallyOpen,
  children,
}: PropsWithChildren<{ title: string; palette: Palette; initiallyOpen?: boolean }>) {
  const [open, setOpen] = useState(!!initiallyOpen);
  return (
    <View
      style={{
        backgroundColor: p.card,
        borderWidth: 1,
        borderColor: p.border,
        borderRadius: 12,
      }}
    >
      <TouchableOpacity
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingVertical: 12,
          paddingHorizontal: 14,
        }}
      >
        <Text style={{ fontSize: 13, fontWeight: '600', color: p.sub }}>{title}</Text>
        <Text style={{ fontSize: 12, color: p.faint }}>{open ? '접기 ▲' : '보기 ▼'}</Text>
      </TouchableOpacity>
      {open ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 14 }}>{children}</View>
      ) : null}
    </View>
  );
}

/**
 * 카드 안에서 쓰는 접이식 설명 토글.
 *
 * Expandable 과 달리 자기 테두리를 그리지 않는다 — 이미 카드 안이라 테두리가
 * 겹치면 지저분해진다. 카드 전체를 누르면 이동하는 구조를 없애고, '설명 보기'
 * 와 '이동' 버튼을 각각 따로 두기 위한 조각이다.
 */
export function InlineToggle({
  open,
  label,
  palette: p,
  onPress,
}: {
  open: boolean;
  label: string;
  palette: Palette;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 }}
    >
      <Text style={{ fontSize: 12, color: p.sub, fontWeight: '600' }}>
        {open ? `${label} 접기` : `${label} 보기`}
      </Text>
      <Text style={{ fontSize: 10, color: p.faint }}>{open ? '▲' : '▼'}</Text>
    </TouchableOpacity>
  );
}

/** 관심종목 별표 — 카드 오른쪽 위에 놓는다. 채워진 별(★)이면 담긴 상태. */
export function StarButton({
  watched,
  palette: p,
  onPress,
  label,
}: {
  watched: boolean;
  palette: Palette;
  onPress: () => void;
  /** 스크린리더가 어느 종목인지 알 수 있게 — 목록에서 별이 여러 개일 때 중요 */
  label?: string;
}) {
  const what = label ? `${label} ` : '';
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: watched }}
      accessibilityLabel={watched ? `${what}관심종목에서 빼기` : `${what}관심종목에 담기`}
      // 별 자체는 작아서 탭하기 어렵다 — 주변까지 터치 영역을 넓힌다
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      style={{ paddingHorizontal: 2 }}
    >
      <Text style={{ fontSize: 19, color: watched ? p.amber : p.faint }}>
        {watched ? '★' : '☆'}
      </Text>
    </TouchableOpacity>
  );
}

export function Footer({ palette: p }: { palette: Palette }) {
  return (
    <View style={{ paddingVertical: 20, gap: 6 }}>
      <Text style={{ fontSize: 11, color: p.faint, lineHeight: 16 }}>⚠ {DISCLAIMER}</Text>
      <Text style={{ fontSize: 11, color: p.faint }}>
        {BRAND_NAME} · 문의 {CONTACT_EMAIL}
      </Text>
    </View>
  );
}
