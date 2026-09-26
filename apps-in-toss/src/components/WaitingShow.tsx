import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Text, TouchableOpacity, View } from 'react-native';
import { TIPS, type Tip, type TipCategory } from '../tips';
import type { Palette } from '../theme';
import { SlingshotGame } from './SlingshotGame';
import { lh } from '../lineHeight';

// 기다리는 동안 보여 주는 화면 — 새총 게임 + 경제·주식·매크로 짧은 글.
//
// 사진 분석(10~40초)과 패턴 스캔(1~2분)은 빈 스피너만 보고 기다리기엔 길다.
// 직접 해 볼 수 있는 작은 게임(components/SlingshotGame)으로 시간을 채우고, 그
// 아래에 읽을거리를 둔다. 경과 초가 계속 바뀌어 '멈춘 게 아니라 일하는 중'임도 보인다.
// 부모가 로딩 중일 때만 그린다 — 사라지면 게임 루프·타이머도 함께 멈춘다.

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

/** 경과 초 — 숫자가 바뀌어야 '멈추지 않았다'는 게 보인다. 매초 이것만 다시 그린다
 *  (부모를 다시 그리면 게임 판까지 매초 다시 그려진다). */
function Elapsed({ prefix, color }: { prefix: string; color: string }) {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <Text style={{ fontSize: 13, color, textAlign: 'center' }}>
      {prefix}
      {sec}초째
    </Text>
  );
}

/**
 * 기다리는 화면 한 장. progress 가 있으면(0~1) 진행 막대를 함께 보여 준다.
 * onInteract 는 게임에서 새총을 당기는 동안 true — 부모 ScrollView 의 스크롤을 잠근다.
 */
export function WaitingShow({
  palette: p,
  title,
  subtitle,
  progress,
  onInteract,
}: {
  palette: Palette;
  title: string;
  subtitle?: string;
  progress?: number | null;
  onInteract?: (active: boolean) => void;
}) {
  const fade = useRef(new Animated.Value(1)).current;
  // 시작 글은 무작위 — 매번 같은 글부터 나오면 두 번째부터는 읽지 않는다
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * TIPS.length));

  const next = useCallback(() => {
    Animated.timing(fade, { toValue: 0, duration: FADE_MS, useNativeDriver: true }).start(({ finished }) => {
      // 흐려지는 도중 '다음'을 또 누르면 앞 애니메이션은 중단된다 — 그때 넘기면 글이 두 개씩 넘어간다
      if (!finished) {
        return;
      }
      setIdx((i) => (i + 1) % TIPS.length);
      Animated.timing(fade, { toValue: 1, duration: FADE_MS, useNativeDriver: true }).start();
    });
  }, [fade]);

  // 스크린리더에는 시작할 때 한 번만 알린다 — 제목에 진행 숫자(57/300 종목)가 들어가는
  // 화면이 있어, 제목을 라이브 영역으로 두면 2초마다 제목 전체를 다시 읽어 준다.
  const firstTitle = useRef(title);
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility?.(firstTitle.current);
  }, []);

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
      <View style={{ alignItems: 'center', gap: 4 }}>
        <Text style={{ fontSize: 16, fontWeight: '700', color: p.text, textAlign: 'center' }}>{title}</Text>
        <Elapsed prefix={subtitle ? `${subtitle} · ` : ''} color={p.faint} />
      </View>

      {pct !== null ? (
        <View style={{ height: 8, borderRadius: 4, backgroundColor: p.sunken, overflow: 'hidden' }}>
          <View style={{ height: 8, width: `${Math.round(pct * 100)}%`, backgroundColor: p.primary }} />
        </View>
      ) : null}

      <SlingshotGame palette={p} onInteract={onInteract} />

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
          <Text style={{ fontSize: 14, color: p.sub, ...lh(21) }}>{tip.body}</Text>
        </Animated.View>
      </View>
      <Text style={{ fontSize: 11.5, color: p.faint, textAlign: 'center' }}>
        용어·제도 설명이에요 · 투자 권유가 아니에요
      </Text>
    </View>
  );
}
