import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Text, TouchableOpacity, View } from 'react-native';
import { TIPS, type Tip, type TipCategory } from '../tips';
import type { Palette } from '../theme';

// 기다리는 동안 보여 주는 화면 — 춤추는 캔들 캐릭터 + 경제·주식·매크로 짧은 글.
//
// 사진 분석(10~40초)과 패턴 스캔(1~2분)은 사용자가 빈 스피너만 보고 기다리기엔
// 길다. 움직이는 캐릭터로 '멈춘 게 아니라 일하는 중'임을 보여 주고, 그 시간에
// 읽을거리를 준다.
//
// 그리는 방법: SVG·서드파티 네이티브 모듈은 미니앱 런타임에 보장되지 않아
// (CandleChart·TabBar 와 같은 이유) View 몇 개로 그린다. 움직임은 값 하나(beat)를
// 네이티브 드라이버로 돌리고 모든 동작을 거기서 보간한다 — JS 스레드가 바빠도
// (응답 파싱 등) 춤이 끊기지 않고, 멈출 때도 하나만 멈추면 된다.
// '동작 줄이기'를 켠 사용자에게는 움직이지 않는 캐릭터를 보여 준다.

const BEAT_MS = 1200; // 한 마디 — 통통 두 번, 팔 한 번씩
const TIP_MS = 7000; // 글 하나를 보여 주는 시간
const FADE_MS = 220;

/** 분류 칩 색 — 글 상자(sunken) 위에 얹히므로 칩 바탕은 상자와 다른 면이어야 보인다. */
function catColors(p: Palette, cat: TipCategory): { fg: string; bg: string } {
  switch (cat) {
    case '매크로':
      return { fg: p.primary, bg: p.primaryBg };
    case '경제':
      return { fg: p.warnText, bg: p.warnBg };
    case '주식':
      return { fg: p.up, bg: p.upBg };
    default:
      // 차트 — 이평선 보라(첫 보조선 색)를 흰(다크: 카드) 칩에 얹는다
      return { fg: p.ma[0] ?? p.primary, bg: p.card };
  }
}

/** 캔들 캐릭터 — 몸통은 양봉(빨강)·음봉(파랑)을 두 마디마다 바꿔 입는다. */
function CandleBuddy({ palette: p, beat, blink, still }: {
  palette: Palette;
  beat: Animated.Value;
  blink: Animated.Value;
  still: boolean;
}) {
  const [bull, setBull] = useState(true);
  useEffect(() => {
    if (still) {
      return;
    }
    const t = setInterval(() => setBull((b) => !b), BEAT_MS * 2);
    return () => clearInterval(t);
  }, [still]);

  const body = bull ? p.up : p.down;
  const ink = '#FFFFFF';
  const at = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
  const hop = beat.interpolate({ inputRange: at, outputRange: [0, -9, -13, -9, 0, -9, -13, -9, 0] });
  const squashY = beat.interpolate({
    inputRange: [0, 0.06, 0.25, 0.44, 0.5, 0.56, 0.75, 0.94, 1],
    outputRange: [0.9, 0.97, 1.04, 0.97, 0.9, 0.97, 1.04, 0.97, 0.9],
  });
  const squashX = beat.interpolate({
    inputRange: [0, 0.25, 0.5, 0.75, 1],
    outputRange: [1.08, 0.97, 1.08, 0.97, 1.08],
  });
  const sway = beat.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: ['-7deg', '7deg', '-7deg'],
  });
  // 팔: 어깨를 축으로 돈다 — 어깨에 중심을 둔 상자를 돌리고 팔은 그 중심에서 뻗는다
  // (transformOrigin 은 0.72 런타임에 없다)
  const leftArm = beat.interpolate({
    inputRange: [0, 0.25, 0.5, 0.75, 1],
    outputRange: ['35deg', '150deg', '35deg', '80deg', '35deg'],
  });
  const rightArm = beat.interpolate({
    inputRange: [0, 0.25, 0.5, 0.75, 1],
    outputRange: ['-35deg', '-80deg', '-35deg', '-150deg', '-35deg'],
  });
  const leftLeg = beat.interpolate({
    inputRange: [0, 0.25, 0.5, 1],
    outputRange: [0, -5, 0, 0],
  });
  const rightLeg = beat.interpolate({
    inputRange: [0, 0.5, 0.75, 1],
    outputRange: [0, 0, -5, 0],
  });
  const shadowScale = beat.interpolate({ inputRange: at, outputRange: [1, 0.86, 0.72, 0.86, 1, 0.86, 0.72, 0.86, 1] });

  const ARM = 26; // 팔 길이
  const arm = (rotate: Animated.AnimatedInterpolation<string>, side: 'left' | 'right') => (
    <Animated.View
      style={{
        position: 'absolute',
        top: 26,
        [side]: -ARM + 4,
        width: ARM * 2,
        height: ARM * 2,
        marginTop: -ARM,
        alignItems: 'center',
        transform: [{ rotate: still ? (side === 'left' ? '35deg' : '-35deg') : rotate }],
      }}
    >
      {/* 상자 가운데(어깨)에서 아래로 뻗은 팔 + 손 */}
      <View style={{ position: 'absolute', top: ARM, alignItems: 'center' }}>
        <View style={{ width: 6, height: ARM - 6, borderRadius: 3, backgroundColor: body }} />
        <View style={{ width: 11, height: 11, borderRadius: 5.5, backgroundColor: body, marginTop: -3 }} />
      </View>
    </Animated.View>
  );

  return (
    <View
      style={{ height: 150, alignItems: 'center', justifyContent: 'flex-end' }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View
        style={{
          alignItems: 'center',
          transform: still ? [] : [{ translateY: hop }, { rotate: sway }],
        }}
      >
        {/* 심지 */}
        <View style={{ width: 4, height: 18, borderRadius: 2, backgroundColor: body }} />
        {/* 몸통 + 팔 */}
        <View>
          {arm(leftArm, 'left')}
          {arm(rightArm, 'right')}
          <Animated.View
            style={{
              width: 60,
              height: 74,
              borderRadius: 18,
              backgroundColor: body,
              alignItems: 'center',
              paddingTop: 20,
              transform: still ? [] : [{ scaleX: squashX }, { scaleY: squashY }],
            }}
          >
            {/* 눈 — 흰자 + 눈동자, 가끔 깜빡인다 */}
            <Animated.View style={{ flexDirection: 'row', gap: 12, transform: [{ scaleY: blink }] }}>
              {[0, 1].map((i) => (
                <View
                  key={i}
                  style={{
                    width: 13,
                    height: 15,
                    borderRadius: 7,
                    backgroundColor: ink,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <View style={{ width: 6, height: 7, borderRadius: 3.5, backgroundColor: '#191F28', marginTop: 2 }} />
                </View>
              ))}
            </Animated.View>
            {/* 볼 */}
            <View style={{ flexDirection: 'row', gap: 26, marginTop: 1 }}>
              <View style={{ width: 8, height: 5, borderRadius: 3, backgroundColor: ink, opacity: 0.35 }} />
              <View style={{ width: 8, height: 5, borderRadius: 3, backgroundColor: ink, opacity: 0.35 }} />
            </View>
            {/* 웃는 입 — 아래 테두리만 그린 반원 */}
            <View
              style={{
                width: 18,
                height: 9,
                marginTop: 1,
                borderBottomLeftRadius: 9,
                borderBottomRightRadius: 9,
                borderWidth: 2.5,
                borderTopWidth: 0,
                borderColor: ink,
              }}
            />
          </Animated.View>
        </View>
        {/* 다리 */}
        <View style={{ flexDirection: 'row', gap: 14, marginTop: -2 }}>
          <Animated.View
            style={{ width: 7, height: 14, borderRadius: 3.5, backgroundColor: body,
              transform: still ? [] : [{ translateY: leftLeg }] }}
          />
          <Animated.View
            style={{ width: 7, height: 14, borderRadius: 3.5, backgroundColor: body,
              transform: still ? [] : [{ translateY: rightLeg }] }}
          />
        </View>
      </Animated.View>
      {/* 그림자 — 높이 뛸수록 작아진다 */}
      <Animated.View
        style={{
          width: 54,
          height: 8,
          borderRadius: 4,
          marginTop: 4,
          backgroundColor: p.dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)',
          transform: still ? [] : [{ scaleX: shadowScale }],
        }}
      />
    </View>
  );
}

/**
 * 기다리는 화면 한 장. 부모가 로딩 중일 때만 그린다(사라지면 애니메이션·타이머도 멈춘다).
 * progress 가 있으면(0~1) 진행 막대를 함께 보여 준다.
 */
export function WaitingShow({
  palette: p,
  title,
  subtitle,
  progress,
}: {
  palette: Palette;
  title: string;
  subtitle?: string;
  progress?: number | null;
}) {
  const beat = useRef(new Animated.Value(0)).current;
  const blink = useRef(new Animated.Value(1)).current;
  const fade = useRef(new Animated.Value(1)).current;
  const [still, setStill] = useState(false);
  // 시작 글은 무작위 — 매번 같은 글부터 나오면 두 번째부터는 읽지 않는다
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * TIPS.length));
  const [elapsed, setElapsed] = useState(0);

  // 동작 줄이기 설정을 따른다
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => {
        if (alive) {
          setStill(on);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // 춤과 깜빡임
  useEffect(() => {
    if (still) {
      return;
    }
    const dance = Animated.loop(
      Animated.timing(beat, {
        toValue: 1,
        duration: BEAT_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    const blinking = Animated.loop(
      Animated.sequence([
        Animated.delay(2600),
        Animated.timing(blink, { toValue: 0.1, duration: 70, useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: 90, useNativeDriver: true }),
      ])
    );
    dance.start();
    blinking.start();
    return () => {
      dance.stop();
      blinking.stop();
    };
  }, [still, beat, blink]);

  // 경과 시간 — 숫자가 바뀌어야 '멈추지 않았다'는 게 보인다
  useEffect(() => {
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const next = React.useCallback(() => {
    Animated.timing(fade, { toValue: 0, duration: FADE_MS, useNativeDriver: true }).start(() => {
      setIdx((i) => (i + 1) % TIPS.length);
      Animated.timing(fade, { toValue: 1, duration: FADE_MS, useNativeDriver: true }).start();
    });
  }, [fade]);

  // 글 넘기기 — 사용자가 직접 넘기면 그때부터 다시 센다
  useEffect(() => {
    const t = setTimeout(next, TIP_MS);
    return () => clearTimeout(t);
  }, [idx, next]);

  // TIPS 는 비어 있지 않다(정적 목록) — 인덱스 접근 타입만 좁힌다
  const tip = (TIPS[idx] ?? TIPS[0]) as Tip;
  const tone = catColors(p, tip.cat);
  const pct = progress == null ? null : Math.max(0, Math.min(1, progress));

  return (
    <View style={{ backgroundColor: p.card, borderRadius: 16, padding: 20, gap: 14 }}>
      <CandleBuddy palette={p} beat={beat} blink={blink} still={still} />

      <View style={{ alignItems: 'center', gap: 4 }}>
        <Text
          accessibilityLiveRegion="polite"
          style={{ fontSize: 16, fontWeight: '700', color: p.text, textAlign: 'center' }}
        >
          {title}
        </Text>
        <Text style={{ fontSize: 13, color: p.faint, textAlign: 'center' }}>
          {subtitle ? `${subtitle} · ` : ''}
          {elapsed}초째
        </Text>
      </View>

      {pct !== null ? (
        <View style={{ height: 8, borderRadius: 4, backgroundColor: p.sunken, overflow: 'hidden' }}>
          <View style={{ height: 8, width: `${Math.round(pct * 100)}%`, backgroundColor: p.primary }} />
        </View>
      ) : null}

      {/* 기다리는 동안 한 스푼 */}
      <View style={{ backgroundColor: p.sunken, borderRadius: 12, padding: 16, gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 12.5, fontWeight: '700', color: p.sub }}>기다리는 동안 한 스푼</Text>
          <TouchableOpacity
            onPress={next}
            accessibilityRole="button"
            accessibilityLabel="다음 글"
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            activeOpacity={0.6}
          >
            <Text style={{ fontSize: 13, fontWeight: '600', color: p.primary }}>다음 →</Text>
          </TouchableOpacity>
        </View>
        {/* 가장 긴 글(4줄)에 맞춘 높이 — 글이 바뀔 때 카드 높이가 튀지 않게 */}
        <Animated.View style={{ opacity: fade, gap: 6, minHeight: 116 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ backgroundColor: tone.bg, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 7 }}>
              <Text style={{ fontSize: 11.5, fontWeight: '700', color: tone.fg }}>{tip.cat}</Text>
            </View>
            <Text style={{ fontSize: 15, fontWeight: '700', color: p.text, flexShrink: 1 }}>{tip.title}</Text>
          </View>
          <Text style={{ fontSize: 14, color: p.sub, lineHeight: 21 }}>{tip.body}</Text>
        </Animated.View>
      </View>
      <Text style={{ fontSize: 11.5, color: p.faint, textAlign: 'center' }}>
        용어·제도 설명이에요 · 투자 권유가 아니에요
      </Text>
    </View>
  );
}
