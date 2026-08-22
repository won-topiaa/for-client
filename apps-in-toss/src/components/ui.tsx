import React, { type PropsWithChildren } from 'react';
import { Text, TouchableOpacity, View, type ViewStyle } from 'react-native';
import { BRAND_NAME, CONTACT_EMAIL, DISCLAIMER } from '../env';
import type { Palette } from '../theme';

// 페이지 공용 소형 UI — 카드/칩/버튼/면책 문구

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
