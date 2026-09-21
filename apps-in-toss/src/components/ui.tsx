import React, { useState, type PropsWithChildren } from 'react';
import { Text, TouchableOpacity, View, type ViewStyle } from 'react-native';
import { maybeTrack } from '../analytics';
import { BRAND_NAME, CONTACT_EMAIL, DISCLAIMER } from '../env';
import { ACCENT, GUTTER, RADIUS, type AccentKey, type Palette } from '../theme';

// 페이지 공용 소형 UI — 토스 앱의 시각 언어(TDS)를 따른다.
//
// 토스와 맞춘 것
//  · 카드에 테두리를 두르지 않는다. 옅은 회색 배경 위의 흰 카드로 층을 나눈다.
//  · 모서리를 크게(16) 굴리고 안쪽 여백을 넉넉히(20) 준다.
//  · 버튼은 한 가지 파랑 하나뿐. 기능마다 다른 색 버튼을 두지 않는다.
//  · 본문 글자를 키운다(15). 예전 12~13px 은 토스 화면에서 유독 작아 보였다.

/* ── 페이지 머리 ─────────────────────────────────────────────── */

/** 화면 제목. 토스의 큰 제목처럼 24pt 굵게, 부제는 15pt 회색. */
export function PageHeader({
  title,
  subtitle,
  palette: p,
}: {
  title: string;
  subtitle?: string;
  palette: Palette;
}) {
  return (
    <View style={{ paddingTop: 8, paddingBottom: 4 }}>
      <Text
        accessibilityRole="header"
        style={{ fontSize: 24, fontWeight: '700', color: p.text, letterSpacing: -0.4 }}
      >
        {title}
      </Text>
      {subtitle ? (
        <Text style={{ fontSize: 15, color: p.sub, marginTop: 6, lineHeight: 22 }}>{subtitle}</Text>
      ) : null}
    </View>
  );
}

/** 목록 위의 작은 구역 제목. 오른쪽에 보조 동작(새로고침 등)을 둘 수 있다. */
export function SectionTitle({
  title,
  palette: p,
  right,
}: {
  title: string;
  palette: Palette;
  right?: React.ReactNode;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: 8,
      }}
    >
      <Text style={{ fontSize: 17, fontWeight: '700', color: p.text, letterSpacing: -0.2 }}>
        {title}
      </Text>
      {right}
    </View>
  );
}

/**
 * 꺾쇠 — 짧은 막대 두 개를 기울여 그린다.
 *
 * 글리프를 쓰지 않는 이유: ⌃/⌄(U+2303/U+2304)는 로보토 같은 기본 안드로이드
 * 폰트에 없어서 두부(□)로 나올 수 있다. 접힘/펼침을 알려 주는 표시가 이것
 * 하나뿐인 자리가 있어서, 안 보이면 여는 방법 자체가 사라진다.
 * (회전시킨 View 로 선을 긋는 방식은 CandleChart 의 이평선과 같다 — 이미
 *  운영에서 돌고 있는 방법이다.)
 */
export function Chevron({
  dir,
  color,
  /** 막대 하나의 길이. 꺾쇠 전체 크기는 이 값에 비례한다. */
  size = 8,
}: {
  dir: 'up' | 'down' | 'right';
  color: string;
  size?: number;
}) {
  const t = Math.max(1.4, size * 0.22);
  const bar = {
    position: 'absolute' as const,
    width: size,
    height: t,
    borderRadius: t / 2,
    backgroundColor: color,
  };

  if (dir === 'right') {
    // 두 막대를 세로로 포개고 ±45° 로 꺾어 오른쪽 끝에서 만나게 한다
    const w = size * 0.85;
    const h = size * 1.5;
    return (
      <View style={{ width: w, height: h }}>
        <View
          style={[bar, { left: -size * 0.07, top: h * 0.29 - t / 2, transform: [{ rotate: '45deg' }] }]}
        />
        <View
          style={[bar, { left: -size * 0.07, top: h * 0.71 - t / 2, transform: [{ rotate: '-45deg' }] }]}
        />
      </View>
    );
  }

  // 위/아래: 두 막대를 가로로 나란히 두고 서로 반대로 기울인다
  const w = size * 1.75;
  const h = size * 0.85;
  const up = dir === 'up';
  return (
    <View style={{ width: w, height: h }}>
      <View
        style={[
          bar,
          { left: 0, top: h / 2 - t / 2, transform: [{ rotate: up ? '-35deg' : '35deg' }] },
        ]}
      />
      <View
        style={[
          bar,
          { right: 0, top: h / 2 - t / 2, transform: [{ rotate: up ? '35deg' : '-35deg' }] },
        ]}
      />
    </View>
  );
}

/* ── 면 ─────────────────────────────────────────────────────── */

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
          borderRadius: RADIUS.card,
          padding: 20,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/**
 * 안내·주의 문구 상자.
 *
 * 예전에는 주의 문구를 주황색 맨글씨로 본문 사이에 흘려 두었다. 토스는 이런
 * 고지를 옅은 회색 상자에 담아 본문과 분리한다 — 읽히기는 하되 화면을
 * 어지럽히지 않는다. 투자 고지는 반드시 보여야 하므로 접지 않는다.
 */
export function Notice({
  palette: p,
  tone = 'plain',
  children,
}: PropsWithChildren<{ palette: Palette; tone?: 'plain' | 'warn' }>) {
  const warn = tone === 'warn';
  return (
    <View
      style={{
        backgroundColor: warn ? p.warnBg : p.sunken,
        borderRadius: 12,
        paddingVertical: 12,
        paddingHorizontal: 14,
      }}
    >
      <Text style={{ fontSize: 13, color: warn ? p.warnText : p.sub, lineHeight: 20 }}>
        {children}
      </Text>
    </View>
  );
}

/** 옅은 색 원 안의 아이콘 — 토스 '전체 메뉴'의 기능 아이콘과 같은 모양. */
export function IconChip({
  glyph,
  accent,
  size = 40,
}: {
  glyph: string;
  accent: AccentKey;
  size?: number;
}) {
  const a = ACCENT[accent];
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: a.bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ fontSize: Math.round(size * 0.48) }}>{glyph}</Text>
    </View>
  );
}

/**
 * 토스식 메뉴 행 — 아이콘 · 제목/설명 · 오른쪽 꺾쇠.
 *
 * 홈에서 기능마다 색이 다른 큰 버튼을 세워 두던 구조를 이걸로 바꿨다.
 * 버튼이 여러 개면 무엇이 주된 동작인지 알 수 없고, 토스 화면에서 그런 모양을
 * 보는 일도 없다. 행 전체가 하나의 터치 대상이라 어디를 눌러야 할지도 분명하다.
 */
export function MenuRow({
  title,
  desc,
  glyph,
  accent,
  palette: p,
  onPress,
  badge,
  logName,
}: {
  title: string;
  desc?: string;
  glyph: string;
  accent: AccentKey;
  palette: Palette;
  onPress: () => void;
  badge?: string;
  /** 콘솔 전환 지표용 이름 (src/analytics.tsx LOG). 없으면 기록하지 않는다. */
  logName?: string;
}) {
  return maybeTrack(
    logName,
    title,
    true,
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={desc ? `${title}. ${desc}` : title}
      activeOpacity={0.6}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        paddingVertical: 14,
        paddingHorizontal: 20,
      }}
    >
      <IconChip glyph={glyph} accent={accent} />
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: p.text, letterSpacing: -0.2 }}>
            {title}
          </Text>
          {badge ? <Badge label={badge} palette={p} tone="primary" /> : null}
        </View>
        {desc ? (
          <Text style={{ fontSize: 13.5, color: p.sub, marginTop: 3, lineHeight: 20 }}>{desc}</Text>
        ) : null}
      </View>
      {/* 꺾쇠는 장식 — 행 전체가 이미 하나의 버튼이고 읽을 이름도 달려 있다 */}
      <View accessibilityElementsHidden importantForAccessibility="no" style={{ marginLeft: 2 }}>
        <Chevron dir="right" color={p.disabled} size={9} />
      </View>
    </TouchableOpacity>,
  );
}

/** 행 사이 구분선 — 왼쪽은 아이콘 폭만큼 들여쓴다(토스와 같은 방식). */
export function RowDivider({ palette: p, inset = 74 }: { palette: Palette; inset?: number }) {
  return <View style={{ height: 1, backgroundColor: p.border, marginLeft: inset }} />;
}

/* ── 조각 ───────────────────────────────────────────────────── */

export function Badge({
  label,
  palette: p,
  tone = 'primary',
}: {
  label: string;
  palette: Palette;
  tone?: 'primary' | 'up' | 'warn' | 'plain';
}) {
  const fg =
    tone === 'up' ? p.up : tone === 'warn' ? p.warnText : tone === 'plain' ? p.sub : p.primary;
  const bg =
    tone === 'up' ? p.upBg : tone === 'warn' ? p.warnBg : tone === 'plain' ? p.sunken : p.primaryBg;
  return (
    <View
      style={{
        backgroundColor: bg,
        borderRadius: RADIUS.badge,
        paddingVertical: 3,
        paddingHorizontal: 7,
        flexShrink: 0,
      }}
    >
      <Text style={{ fontSize: 11.5, fontWeight: '700', color: fg }}>{label}</Text>
    </View>
  );
}

/** 알약 모양 선택 칩 — 테두리 없이 면색으로만 상태를 나타낸다(토스 방식). */
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
      activeOpacity={0.7}
      style={{
        paddingVertical: 9,
        paddingHorizontal: 14,
        borderRadius: RADIUS.chip,
        backgroundColor: active ? p.primaryBg : p.sunken,
      }}
    >
      <Text
        style={{
          fontSize: 14,
          color: active ? p.primary : p.sub,
          fontWeight: active ? '700' : '500',
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

/**
 * 분절 선택기(국내/미국, 일봉/주봉/월봉).
 *
 * 토스가 '둘 중 하나'를 고르게 할 때 쓰는 모양 — 회색 바닥 위를 흰 손잡이가
 * 옮겨 다닌다. 칩을 여러 개 늘어놓는 것보다 '한 번에 하나'라는 뜻이 분명하다.
 */
export function Segmented<T extends string | number>({
  options,
  value,
  palette: p,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  palette: Palette;
  onChange: (v: T) => void;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: p.sunken,
        borderRadius: 12,
        padding: 4,
        gap: 4,
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <TouchableOpacity
            key={String(o.value)}
            onPress={() => {
              if (!active) {
                onChange(o.value);
              }
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            activeOpacity={0.8}
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              paddingVertical: 9,
              borderRadius: 9,
              backgroundColor: active ? p.card : 'transparent',
              // 흰 손잡이가 바닥에서 살짝 떠 보이게 — 토스와 같은 아주 옅은 그림자
              ...(active
                ? {
                    shadowColor: '#000000',
                    shadowOpacity: 0.06,
                    shadowRadius: 4,
                    shadowOffset: { width: 0, height: 1 },
                    elevation: 1,
                  }
                : null),
            }}
          >
            <Text
              style={{
                fontSize: 14,
                fontWeight: active ? '700' : '500',
                // 고르지 않은 쪽도 '읽고 나서' 고르는 글자다 — 흰 손잡이가 이미
                // 선택을 말해 주므로, 색으로 더 흐리게 만들 이유가 없다
                color: active ? p.text : p.sub,
              }}
              numberOfLines={1}
            >
              {o.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

/**
 * 주요 버튼 — 토스 버튼과 같은 치수(높이 52 · 모서리 14 · 글자 16 굵게).
 *
 * 색은 tone 으로만 고른다. 예전엔 화면마다 버튼 색을 따로 넘겼는데(초록·앰버·
 * 인디고), 그러면 '무엇이 주된 동작인지'를 색으로 알 수 없다. 토스는 파랑 하나뿐이다.
 */
export function PrimaryButton({
  label,
  disabled,
  palette: p,
  onPress,
  tone = 'primary',
  logName,
}: {
  label: string;
  disabled?: boolean;
  palette: Palette;
  onPress: () => void;
  tone?: 'primary' | 'secondary';
  /** 콘솔 전환 지표용 이름 (src/analytics.tsx LOG). 없으면 기록하지 않는다. */
  logName?: string;
}) {
  const secondary = tone === 'secondary';
  // 비활성과 보조 버튼의 면색을 다르게 둔다 — 둘 다 sunken 이면 '못 누르는 것'과
  // '덜 중요한 것'이 같아 보인다. 글자색도 disabled(1.8:1) 가 아니라 faint 로.
  const bg = disabled ? p.border : secondary ? p.sunken : p.primary;
  const fg = disabled ? p.faint : secondary ? p.sub : p.onPrimary;
  return maybeTrack(
    logName,
    label,
    !disabled,
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      activeOpacity={0.85}
      style={{
        backgroundColor: bg,
        borderRadius: RADIUS.button,
        paddingVertical: 15,
        alignItems: 'center',
      }}
    >
      <Text style={{ color: fg, fontSize: 16, fontWeight: '700' }}>{label}</Text>
    </TouchableOpacity>,
  );
}

/** 글자만 있는 보조 동작(새로고침·분석하기 →) — 토스의 파란 텍스트 버튼. */
export function TextButton({
  label,
  palette: p,
  onPress,
  size = 14,
  logName,
}: {
  label: string;
  palette: Palette;
  onPress: () => void;
  size?: number;
  /** 콘솔 전환 지표용 이름 (src/analytics.tsx LOG). 없으면 기록하지 않는다. */
  logName?: string;
}) {
  return maybeTrack(
    logName,
    label,
    true,
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      activeOpacity={0.6}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
    >
      <Text style={{ fontSize: size, color: p.primary, fontWeight: '600' }}>{label}</Text>
    </TouchableOpacity>,
  );
}

// 설명 문구는 기본으로 접어 둔다 — 작은 폰 화면에서 본문(차트·카드)이 먼저
// 보이도록. 면책 문구(Footer)는 예외로 항상 노출한다(투자 정보 앱 고지 의무).
export function Expandable({
  title,
  palette: p,
  initiallyOpen,
  /** 자기 면색. 기본은 흰 카드 — 흰 카드 *안에* 넣을 때는 p.sunken 을 넘겨야
   *  흰 위에 흰이 겹쳐 토글이 보이지 않는 일이 없다. */
  surface,
  children,
}: PropsWithChildren<{
  title: string;
  palette: Palette;
  initiallyOpen?: boolean;
  surface?: string;
}>) {
  const [open, setOpen] = useState(!!initiallyOpen);
  return (
    <View style={{ backgroundColor: surface ?? p.card, borderRadius: RADIUS.card }}>
      <TouchableOpacity
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        activeOpacity={0.6}
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingVertical: 16,
          paddingHorizontal: 20,
        }}
      >
        <Text style={{ fontSize: 15, fontWeight: '600', color: p.text, flexShrink: 1 }}>
          {title}
        </Text>
        {/* 이 카드에서 접힘/펼침을 알려 주는 표시는 이것 하나뿐이라, 장식용
            회색이 아니라 읽히는 회색으로 칠한다 */}
        <View accessibilityElementsHidden importantForAccessibility="no" style={{ marginLeft: 8 }}>
          <Chevron dir={open ? 'up' : 'down'} color={p.faint} size={9} />
        </View>
      </TouchableOpacity>
      {open ? <View style={{ paddingHorizontal: 20, paddingBottom: 18 }}>{children}</View> : null}
    </View>
  );
}

/**
 * 카드 안에서 쓰는 접이식 설명 토글.
 *
 * Expandable 과 달리 자기 면을 그리지 않는다 — 이미 카드 안이라 면이 겹치면
 * 지저분해진다.
 */
export function InlineToggle({
  open,
  label,
  palette: p,
  onPress,
  /** 스크린리더용 — 어느 카드의 설명인지 밝힌다. 화면에는 'label 보기' 만
   *  보이므로, 이것이 없으면 카드가 여럿일 때 전부 똑같이 읽힌다. */
  of,
}: {
  open: boolean;
  label: string;
  palette: Palette;
  onPress: () => void;
  of?: string;
}) {
  const what = of ? `${of} ` : '';
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={open ? `${what}${label} 접기` : `${what}${label} 보기`}
      activeOpacity={0.6}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        // 이 토글이 설명을 여는 유일한 통로다 — 손가락 기준 최소 44pt 를 준다
        minHeight: 44,
      }}
    >
      <Text style={{ fontSize: 14, color: p.primary, fontWeight: '600' }}>
        {open ? `${label} 접기` : `${label} 보기`}
      </Text>
      {/* 꺾쇠는 장식 — 옆 글자가 이미 '보기 / 접기'를 말해 준다 */}
      <View accessibilityElementsHidden importantForAccessibility="no">
        <Chevron dir={open ? 'up' : 'down'} color={p.primary} size={8} />
      </View>
    </TouchableOpacity>
  );
}

/** 관심종목 별표 — 카드 오른쪽 위에 놓는다. 채워진 별(★)이면 담긴 상태. */
export function StarButton({
  watched,
  palette: p,
  onPress,
  label,
  logName,
}: {
  watched: boolean;
  palette: Palette;
  onPress: () => void;
  /** 스크린리더가 어느 종목인지 알 수 있게 — 목록에서 별이 여러 개일 때 중요 */
  label?: string;
  /** 콘솔 전환 지표용 이름. '담을 때'만 기록한다 — 빼는 동작은 전환이 아니다. */
  logName?: string;
}) {
  const what = label ? `${label} ` : '';
  return maybeTrack(
    logName,
    label,
    !watched,
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: watched }}
      accessibilityLabel={watched ? `${what}관심종목에서 빼기` : `${what}관심종목에 담기`}
      // 별 자체는 작아서 탭하기 어렵다 — 주변까지 터치 영역을 넓힌다
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      style={{ paddingHorizontal: 2 }}
    >
      <Text style={{ fontSize: 20, color: watched ? p.warn : p.faint }}>
        {watched ? '★' : '☆'}
      </Text>
    </TouchableOpacity>,
  );
}

export function Footer({ palette: p }: { palette: Palette }) {
  return (
    <View style={{ paddingVertical: 24, paddingHorizontal: 2, gap: 8 }}>
      {/* 면책 문구는 고지 의무가 있는 글이다 — 장식용 회색(disabled)으로 칠하면
          화면에 있어도 읽히지 않아 고지한 것이 되지 않는다 */}
      <Text style={{ fontSize: 12, color: p.faint, lineHeight: 18 }}>⚠ {DISCLAIMER}</Text>
      <Text style={{ fontSize: 12, color: p.faint }}>
        {BRAND_NAME} · 문의 {CONTACT_EMAIL}
      </Text>
    </View>
  );
}

export { GUTTER };
