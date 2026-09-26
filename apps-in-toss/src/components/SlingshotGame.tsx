import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, PanResponder, Text, View, type LayoutChangeEvent } from 'react-native';
import type { Palette } from '../theme';

// 기다리는 동안 하는 새총 게임 — 빨간 캔들(황소)을 당겼다 놓아 곰을 맞힌다.
//
// 만드는 방법
//  · 드래그는 RN 기본 PanResponder. 제스처 라이브러리는 미니앱 런타임에 보장되지
//    않는다(SVG 를 안 쓰는 것과 같은 이유).
//  · 날아가는 동안의 위치는 Animated.ValueXY 에 매 프레임 setValue 한다 — 리액트
//    다시 그리기 없이 그 View 하나만 움직이므로 저가 폰에서도 부드럽다. 화면을
//    다시 그리는 건 곰이 맞았을 때·판이 바뀔 때처럼 드문 순간뿐이다.
//  · 안드로이드 ScrollView 는 자식의 드래그를 빼앗아 간다 — 당기는 동안에는
//    onInteract(true) 로 부모 화면의 스크롤을 잠근다.
//  · 모든 좌표는 게임 판 기준 px. 선은 CandleChart 처럼 가운데를 축으로 돌린 View.

const H = 210; // 게임 판 높이
const GROUND = H - 18; // 땅 높이(y)
const R = 14; // 캔들(탄) 반지름
const ANCHOR_X = 72; // 새총 가운데
const ANCHOR_Y = GROUND - 78;
const FORK = 12; // 새총 갈래 간격(반)
const MAX_PULL = 72;
const POWER = 8.0; // 당긴 1px 당 발사 속도(px/s) — 최대 약 576px/s, 45° 사거리 약 340px
const GRAVITY = 980; // px/s²
const SHOTS = 3;
const BEAR_R = 13;
const BLOCK_W = 16;
const BLOCK_HEIGHTS = [18, 34, 50];
const BROWN = '#8B5E3C';
const BROWN_LIGHT = '#D2A679';
const BAND = '#5D4037';
const WOOD = '#A1887F';

type Target = { x: number; blockH: number; hit: boolean };

// 앱을 켜 둔 동안의 최고 기록 (디스크에 남기지 않는다 — 기다리는 동안의 놀이일 뿐)
let bestScore = 0;

/** 곰 세 마리를 새총 오른쪽 빈 곳에 고르게 세운다 — 좁은 폰(게임 판 약 280px)에서도
 *  곰끼리 겹치지 않게 간격을 폭에서 계산한다. */
function newRound(width: number): Target[] {
  // 오른쪽 끝: 판 안(width-20)이면서 최대 사거리 안(새총에서 280px) — 태블릿·폴드처럼
  // 판이 넓어도 끝 곰을 맞힐 수 있게. 왼쪽 끝: 좁은 판(240px)이면 새총 쪽으로 당긴다.
  const hi = Math.min(width - 20, ANCHOR_X + 280);
  const lo = Math.min(ANCHOR_X + 110, hi - 72);
  const gap = (hi - lo) / 2;
  const jitter = Math.min(8, Math.max(0, gap - 36) / 2); // 곰 폭(귀 포함 32px)보다 가까워지지 않게
  return [0, 1, 2].map((i) => ({
    x: lo + gap * i + (Math.random() * 2 - 1) * jitter,
    blockH: BLOCK_HEIGHTS[Math.floor(Math.random() * BLOCK_HEIGHTS.length)] ?? 34,
    hit: false,
  }));
}

/** 곰 머리 중심 */
function bearCenter(t: Target) {
  return { x: t.x, y: GROUND - t.blockH - BEAR_R };
}

/** 탄(원)이 곰(원) 또는 받침 캔들(사각형)에 닿았나 */
function hits(x: number, y: number, t: Target): boolean {
  const b = bearCenter(t);
  if (Math.hypot(x - b.x, y - b.y) < R + BEAR_R - 2) {
    return true;
  }
  const cx = Math.max(t.x - BLOCK_W / 2, Math.min(x, t.x + BLOCK_W / 2));
  const cy = Math.max(GROUND - t.blockH, Math.min(y, GROUND));
  return Math.hypot(x - cx, y - cy) < R - 1;
}

/** 두 점을 잇는 선 — 가운데를 축으로 돌린 View (transformOrigin 은 0.72 에 없다) */
function Line({ x1, y1, x2, y2, w, color }: {
  x1: number; y1: number; x2: number; y2: number; w: number; color: string;
}) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 0.5) {
    return null;
  }
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: (x1 + x2) / 2 - len / 2,
        top: (y1 + y2) / 2 - w / 2,
        width: len,
        height: w,
        borderRadius: w / 2,
        backgroundColor: color,
        transform: [{ rotate: `${Math.atan2(y2 - y1, x2 - x1)}rad` }],
      }}
    />
  );
}

// memo: 드래그할 때마다(초당 수십 번) 판 전체가 다시 그려지는데, 곰까지 매번 새
// 보간 노드를 만들면 저가 안드로이드에서 버벅이고 넘어진 곰이 한 프레임 되살아난다.
const Bear = memo(function Bear({ x, blockH, fall, color }: {
  x: number; blockH: number; fall: Animated.Value; color: string;
}) {
  const { drop, spin, fade } = useMemo(() => ({
    drop: fall.interpolate({ inputRange: [0, 1], outputRange: [0, 46] }),
    spin: fall.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '100deg'] }),
    fade: fall.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 1, 0] }),
  }), [fall]);
  const t = { x, blockH };
  const top = GROUND - t.blockH - BEAR_R * 2 - 3;
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: t.x - BEAR_R - 3,
        top,
        width: BEAR_R * 2 + 6,
        alignItems: 'center',
        opacity: fade,
        transform: [{ translateY: drop }, { rotate: spin }],
      }}
    >
      {/* 귀 */}
      <View style={{ flexDirection: 'row', gap: 12, marginBottom: -7, zIndex: 0 }}>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: BROWN }} />
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: BROWN }} />
      </View>
      {/* 얼굴 */}
      <View
        style={{
          width: BEAR_R * 2,
          height: BEAR_R * 2,
          borderRadius: BEAR_R,
          backgroundColor: BROWN,
          alignItems: 'center',
          paddingTop: 8,
        }}
      >
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: '#191F28' }} />
          <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: '#191F28' }} />
        </View>
        <View
          style={{
            width: 11,
            height: 8,
            borderRadius: 4,
            backgroundColor: BROWN_LIGHT,
            marginTop: 2,
            alignItems: 'center',
          }}
        >
          <View style={{ width: 4, height: 3, borderRadius: 1.5, backgroundColor: '#191F28', marginTop: 1 }} />
        </View>
      </View>
      {/* 받침 — 파란(음봉) 캔들 */}
      <View style={{ alignItems: 'center', marginTop: 3 }}>
        <View style={{ width: BLOCK_W, height: t.blockH, borderRadius: 3, backgroundColor: color }} />
      </View>
    </Animated.View>
  );
});

export const SlingshotGame = memo(function SlingshotGame({ palette: p, onInteract }: {
  palette: Palette;
  /** 당기는 동안 true — 부모 ScrollView 의 스크롤을 잠근다 */
  onInteract?: (active: boolean) => void;
}) {
  const [width, setWidth] = useState(0);
  const [targets, setTargets] = useState<Target[]>([]);
  // x·y: 화면에 보이는 탄 위치(판 밖으로 안 나가게 자른 값), dx·dy: 실제로 당긴 양(발사 속도)
  const [drag, setDrag] = useState<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const [shotsLeft, setShotsLeft] = useState(SHOTS);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(bestScore);
  const [message, setMessage] = useState<string | null>(null);
  const [showHint, setShowHint] = useState(true);

  const pos = useRef(new Animated.ValueXY({ x: ANCHOR_X - R, y: ANCHOR_Y - R })).current;
  const falls = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;
  const raf = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const onInteractRef = useRef(onInteract);
  onInteractRef.current = onInteract;

  // 프레임 루프·제스처 처리기가 읽는 값 — 상태를 기다리지 않고 바로 쓰려고 ref 에 둔다
  const game = useRef({
    phase: 'ready' as 'ready' | 'drag' | 'fly' | 'between',
    width: 0,
    targets: [] as Target[],
    shotsLeft: SHOTS,
    score: 0,
    start: { x: 0, y: 0 },
    x: 0, y: 0, vx: 0, vy: 0, t: 0, last: -1, bounces: 0,
  });

  const setLocked = (on: boolean) => onInteractRef.current?.(on);

  const resetShot = () => {
    const g = game.current;
    g.phase = 'ready';
    pos.setValue({ x: ANCHOR_X - R, y: ANCHOR_Y - R });
  };

  const startRound = () => {
    const g = game.current;
    const round = newRound(g.width);
    g.targets = round;
    g.shotsLeft = SHOTS;
    falls.forEach((f) => f.setValue(0));
    setTargets(round);
    setShotsLeft(SHOTS);
    setMessage(null);
    resetShot();
  };

  const onHit = (i: number) => {
    const g = game.current;
    g.score += 1;
    if (g.score > bestScore) {
      bestScore = g.score;
      setBest(bestScore);
    }
    setScore(g.score);
    setTargets(g.targets.map((t) => ({ ...t })));
    const f = falls[i];
    if (f) {
      Animated.timing(f, { toValue: 1, duration: 650, easing: Easing.in(Easing.quad), useNativeDriver: true }).start();
    }
  };

  const endShot = () => {
    const g = game.current;
    g.shotsLeft -= 1;
    setShotsLeft(g.shotsLeft);
    const allDown = g.targets.every((t) => t.hit);
    if (allDown || g.shotsLeft <= 0) {
      g.phase = 'between';
      setMessage(allDown ? '곰을 모두 맞혔어요!' : '다음 판에서 다시 해 봐요');
      timer.current = setTimeout(() => {
        if (alive.current) {
          startRound();
        }
      }, 1200);
      return;
    }
    // 다음 캔들을 새총에 올린다
    timer.current = setTimeout(() => {
      if (alive.current) {
        resetShot();
      }
    }, 250);
  };

  const fly = (vx: number, vy: number) => {
    const g = game.current;
    g.phase = 'fly';
    g.x = g.start.x;
    g.y = g.start.y;
    g.vx = vx;
    g.vy = vy;
    g.t = 0;
    g.last = -1;
    g.bounces = 0;
    const step = (ts: number) => {
      if (!alive.current) {
        return;
      }
      const dt = g.last < 0 ? 1 / 60 : Math.min(0.033, (ts - g.last) / 1000);
      g.last = ts;
      g.t += dt;
      g.vy += GRAVITY * dt;
      g.x += g.vx * dt;
      g.y += g.vy * dt;
      if (g.y + R > GROUND) {
        g.y = GROUND - R;
        g.vy = -g.vy * 0.42;
        g.vx *= 0.7;
        g.bounces += 1;
      }
      g.targets.forEach((t, i) => {
        if (!t.hit && hits(g.x, g.y, t)) {
          t.hit = true;
          g.vx *= 0.6; // 부딪히면 느려진다
          onHit(i);
        }
      });
      pos.setValue({ x: g.x - R, y: g.y - R });
      const stopped = g.y >= GROUND - R - 0.5 && Math.abs(g.vx) < 30 && Math.abs(g.vy) < 60;
      // 오래 굴러다니면 다음 발사를 못 해 답답하다 — 두 번 튀거나 3초가 지나면 끝낸다
      if (g.x - R > g.width + 12 || g.x + R < -12 || g.t > 3 || g.bounces >= 2 || stopped) {
        raf.current = null;
        endShot();
        return;
      }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: (e) => {
        const g = game.current;
        if (g.phase !== 'ready') {
          return false;
        }
        const { locationX, locationY } = e.nativeEvent;
        if (Math.hypot(locationX - ANCHOR_X, locationY - ANCHOR_Y) > 48) {
          return false;
        }
        g.start = { x: locationX, y: locationY };
        setLocked(true); // grant 보다 한 박자 먼저 — iOS 스크롤이 당기기를 가로채기 전에
        return true;
      },
      onMoveShouldSetPanResponder: () => false,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        game.current.phase = 'drag';
        setShowHint(false);
        setLocked(true);
      },
      onPanResponderMove: (_e, gs) => {
        const g = game.current;
        if (g.phase !== 'drag') {
          return;
        }
        let dx = g.start.x + gs.dx - ANCHOR_X;
        let dy = g.start.y + gs.dy - ANCHOR_Y;
        const len = Math.hypot(dx, dy);
        if (len > MAX_PULL) {
          dx = (dx / len) * MAX_PULL;
          dy = (dy / len) * MAX_PULL;
        }
        const x = Math.max(R + 2, ANCHOR_X + dx); // 판 왼쪽 밖으로 나가 잘리지 않게
        const y = Math.min(GROUND - R, ANCHOR_Y + dy);
        pos.setValue({ x: x - R, y: y - R });
        setDrag({ x, y, dx, dy });
      },
      onPanResponderRelease: (_e, gs) => {
        const g = game.current;
        setLocked(false);
        setDrag(null);
        if (g.phase !== 'drag') {
          return;
        }
        let dx = g.start.x + gs.dx - ANCHOR_X;
        let dy = g.start.y + gs.dy - ANCHOR_Y;
        const len = Math.hypot(dx, dy);
        // 손가락이 거의 움직이지 않았거나(탭) 거의 안 당겼으면 발사로 치지 않는다
        if (Math.hypot(gs.dx, gs.dy) < 8 || len < 12) {
          resetShot();
          return;
        }
        if (len > MAX_PULL) {
          dx = (dx / len) * MAX_PULL;
          dy = (dy / len) * MAX_PULL;
        }
        // 발사 위치는 화면에 보이던 자리(잘림 방지로 당겨 놓은 곳) — 속도는 당긴 만큼
        g.start = { x: Math.max(R + 2, ANCHOR_X + dx), y: Math.min(GROUND - R, ANCHOR_Y + dy) };
        fly(-dx * POWER, -dy * POWER);
      },
      onPanResponderTerminate: () => {
        setLocked(false);
        setDrag(null);
        if (game.current.phase === 'drag') {
          resetShot();
        }
      },
    })
  ).current;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (raf.current != null) {
        cancelAnimationFrame(raf.current);
      }
      if (timer.current) {
        clearTimeout(timer.current);
      }
      onInteractRef.current?.(false); // 당기는 도중 화면이 닫혀도 스크롤 잠금이 남지 않게
    };
  }, []);

  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w <= 0 || w === game.current.width) {
      return;
    }
    game.current.width = w;
    setWidth(w);
    if (game.current.phase === 'ready' || game.current.targets.length === 0) {
      startRound();
    }
  };

  // 당기는 동안의 조준 점 — 발사하면 지나갈 길을 미리 보여 준다
  const aim: { x: number; y: number }[] = [];
  if (drag) {
    // 발사와 같은 식 — 출발점은 보이는 자리, 속도는 당긴 양 (fly(-dx·POWER, -dy·POWER))
    const vx = -drag.dx * POWER;
    const vy = -drag.dy * POWER;
    for (let i = 1; i <= 8; i++) {
      const t = i * 0.07;
      const y = drag.y + vy * t + 0.5 * GRAVITY * t * t;
      if (y > GROUND) {
        break;
      }
      aim.push({ x: drag.x + vx * t, y });
    }
  }
  const forkL = { x: ANCHOR_X - FORK, y: ANCHOR_Y - 4 };
  const forkR = { x: ANCHOR_X + FORK, y: ANCHOR_Y - 4 };
  const band = drag ?? { x: ANCHOR_X, y: ANCHOR_Y };

  return (
    <View
      onLayout={onLayout}
      accessible
      accessibilityLabel="새총 게임. 빨간 캔들을 뒤로 당겼다 놓아 곰을 맞혀요."
      style={{
        height: H,
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: p.dark ? '#1B2433' : '#EAF3FF',
      }}
    >
      {/* 땅 */}
      <View style={{ position: 'absolute', left: 0, right: 0, top: GROUND, bottom: 0,
        backgroundColor: p.dark ? '#26303D' : '#DDE8D2' }} />

      {/* 곰과 받침 */}
      {width > 0
        ? targets.map((t, i) => <Bear key={`${i}-${t.x}`} x={t.x} blockH={t.blockH} fall={falls[i] ?? falls[0]!} color={p.down} />)
        : null}

      {/* 새총 기둥과 뒷고무줄 */}
      <View style={{ position: 'absolute', left: ANCHOR_X - 3, top: ANCHOR_Y + 8, width: 6,
        height: GROUND - ANCHOR_Y - 8, borderRadius: 3, backgroundColor: WOOD }} />
      <Line x1={ANCHOR_X} y1={ANCHOR_Y + 10} x2={forkL.x} y2={forkL.y} w={5} color={WOOD} />
      <Line x1={ANCHOR_X} y1={ANCHOR_Y + 10} x2={forkR.x} y2={forkR.y} w={5} color={WOOD} />
      <Line x1={forkL.x} y1={forkL.y} x2={band.x} y2={band.y} w={3} color={BAND} />

      {/* 조준 점 */}
      {aim.map((d, i) => (
        <View
          key={i}
          pointerEvents="none"
          style={{ position: 'absolute', left: d.x - 2.5, top: d.y - 2.5, width: 5, height: 5,
            borderRadius: 2.5, backgroundColor: p.faint, opacity: 1 - i * 0.1 }}
        />
      ))}

      {/* 탄 — 빨간(양봉) 캔들 */}
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: R * 2,
          height: R * 2,
          transform: [{ translateX: pos.x }, { translateY: pos.y }],
          alignItems: 'center',
        }}
      >
        <View style={{ position: 'absolute', top: -5, width: 2, height: 6, backgroundColor: p.up }} />
        <View style={{ width: R * 2 - 4, height: R * 2, borderRadius: 7, backgroundColor: p.up,
          alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ flexDirection: 'row', gap: 5 }}>
            {[0, 1].map((k) => (
              <View key={k} style={{ width: 7, height: 8, borderRadius: 4, backgroundColor: '#FFFFFF',
                alignItems: 'center', justifyContent: 'center' }}>
                <View style={{ width: 3, height: 4, borderRadius: 1.5, backgroundColor: '#191F28' }} />
              </View>
            ))}
          </View>
        </View>
      </Animated.View>

      {/* 앞고무줄 — 탄 위로 지나가야 당긴 느낌이 난다 */}
      <Line x1={forkR.x} y1={forkR.y} x2={band.x} y2={band.y} w={3} color={BAND} />

      {/* 점수판 */}
      <View pointerEvents="none" style={{ position: 'absolute', left: 12, right: 12, top: 10,
        flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
          점수 {score}
          <Text style={{ fontWeight: '500', color: p.faint }}> · 최고 {best}</Text>
        </Text>
        <View style={{ flexDirection: 'row', gap: 4 }}>
          {Array.from({ length: SHOTS }, (_, i) => (
            <View key={i} style={{ width: 9, height: 11, borderRadius: 3,
              backgroundColor: i < shotsLeft ? p.up : p.border }} />
          ))}
        </View>
      </View>

      {showHint || message ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 40, alignItems: 'center' }}>
          <Text style={{ fontSize: 13, fontWeight: message ? '700' : '500', color: message ? p.text : p.sub }}>
            {message ?? '빨간 캔들을 뒤로 당겼다 놓아 곰을 맞혀 보세요'}
          </Text>
        </View>
      ) : null}

      {/* 제스처는 맨 위의 투명 판이 받는다 — locationX/Y 가 곧 게임 좌표가 된다 */}
      <View style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }} {...pan.panHandlers} />
    </View>
  );
});
