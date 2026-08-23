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
}: {
  label: string;
  disabled?: boolean;
  palette: Palette;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={{
        backgroundColor: disabled ? p.border : p.up,
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
