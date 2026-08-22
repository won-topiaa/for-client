import React, { useMemo, useState } from 'react';
import { Text, View, type LayoutChangeEvent } from 'react-native';
import type { Candle, TimeValue } from '../api/types';
import { fmtDateShort, fmtPrice } from '../format';

// 순수 RN View 로 그리는 캔들차트.
// 미니앱 런타임(react-native 는 호스트가 공급)에는 서드파티 차트/SVG 모듈이
// 보장되지 않으므로, 캔들=절대배치 View 2개(꼬리+몸통), 이평선=회전시킨 짧은
// 선분 View 로 그린다. 표시 봉 수를 제한(maxBars)해 View 수를 억제한다.

export interface ChartLine {
  color: string;
  points: TimeValue[];
  width?: number;
}

export interface ChartMarker {
  time: string;
  /** 화살표=이평선이 버팀, 원=뚫림 (웹과 동일한 모양 규약) */
  shape: 'arrowUp' | 'arrowDown' | 'circle';
  color: string;
  position: 'below' | 'above';
}

interface ChartColors {
  up: string;
  down: string;
  grid: string;
  text: string;
}

interface Props {
  candles: Candle[];
  lines?: ChartLine[];
  markers?: ChartMarker[];
  height?: number;
  /** 최근 N개 봉만 표시 (기본 120 — 폰 폭에서 봉이 보이는 한계) */
  maxBars?: number;
  colors: ChartColors;
  showPriceAxis?: boolean;
  showDates?: boolean;
}

const AXIS_W = 52;
const DATE_H = 16;
const GRID_STEPS = 4;

interface Box {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
  color: string;
  radius?: number;
  rotate?: number; // rad
}

export function CandleChart({
  candles,
  lines = [],
  markers = [],
  height = 280,
  maxBars = 120,
  colors,
  showPriceAxis = true,
  showDates = true,
}: Props) {
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const plotW = Math.max(0, width - (showPriceAxis ? AXIS_W : 0));
  const plotH = Math.max(0, height - (showDates ? DATE_H : 0));

  const model = useMemo(() => {
    if (plotW <= 0 || plotH <= 0 || candles.length === 0) {
      return null;
    }
    const visible = candles.length > maxBars ? candles.slice(-maxBars) : candles;
    const n = visible.length;
    const timeIndex = new Map<string, number>();
    visible.forEach((c, i) => timeIndex.set(c.time, i));

    // 가격 범위: 보이는 봉 + 보이는 구간의 라인 값
    let min = Infinity;
    let max = -Infinity;
    for (const c of visible) {
      if (c.low < min) {
        min = c.low;
      }
      if (c.high > max) {
        max = c.high;
      }
    }
    for (const line of lines) {
      for (const p of line.points) {
        if (timeIndex.has(p.time)) {
          if (p.value < min) {
            min = p.value;
          }
          if (p.value > max) {
            max = p.value;
          }
        }
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return null;
    }
    const pad = (max - min) * 0.05 || Math.abs(max) * 0.01 || 1;
    min -= pad;
    max += pad;
    const range = max - min;

    const step = plotW / n;
    const x = (i: number) => i * step + step / 2;
    const y = (v: number) => plotH * (1 - (v - min) / range);

    // 캔들 (꼬리 + 몸통)
    const bodyW = Math.max(1.5, Math.min(9, step * 0.62));
    const candleBoxes: Box[] = [];
    visible.forEach((c, i) => {
      const color = c.close >= c.open ? colors.up : colors.down;
      const cx = x(i);
      const wickTop = y(c.high);
      candleBoxes.push({
        key: `w${i}`,
        left: cx - 0.5,
        top: wickTop,
        width: 1,
        height: Math.max(1, y(c.low) - wickTop),
        color,
      });
      const bodyTop = y(Math.max(c.open, c.close));
      candleBoxes.push({
        key: `b${i}`,
        left: cx - bodyW / 2,
        top: bodyTop,
        width: bodyW,
        height: Math.max(1, y(Math.min(c.open, c.close)) - bodyTop),
        color,
      });
    });

    // 이평선: 인접 점 사이를 회전한 선분 View 로 연결
    const lineBoxes: Box[] = [];
    lines.forEach((line, li) => {
      const lw = line.width ?? 2;
      const pts: { px: number; py: number }[] = [];
      for (const p of line.points) {
        const i = timeIndex.get(p.time);
        if (i !== undefined) {
          pts.push({ px: x(i), py: y(p.value) });
        }
      }
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        if (!a || !b) {
          continue;
        }
        const dx = b.px - a.px;
        const dy = b.py - a.py;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.5) {
          continue;
        }
        lineBoxes.push({
          key: `l${li}-${i}`,
          left: (a.px + b.px) / 2 - len / 2,
          top: (a.py + b.py) / 2 - lw / 2,
          width: len,
          height: lw,
          color: line.color,
          radius: lw / 2,
          rotate: Math.atan2(dy, dx),
        });
      }
    });

    // 마커
    const markerViews = markers.flatMap((m, mi) => {
      const i = timeIndex.get(m.time);
      if (i === undefined) {
        return [];
      }
      const c = visible[i];
      if (!c) {
        return [];
      }
      const cx = x(i);
      const my =
        m.position === 'below'
          ? Math.min(plotH - 8, y(c.low) + 4)
          : Math.max(2, y(c.high) - 11);
      return [{ key: `m${mi}`, cx, my, shape: m.shape, color: m.color }];
    });

    // 가격 눈금 (GRID_STEPS 등분)
    const gridLevels = Array.from({ length: GRID_STEPS + 1 }, (_, k) => {
      const v = max - (range * k) / GRID_STEPS;
      return { top: y(v), label: fmtPrice(v) };
    });

    // 날짜 라벨: 처음/중간/끝
    const first = visible[0];
    const mid = visible[Math.floor((n - 1) / 2)];
    const last = visible[n - 1];
    const dateLabels =
      n >= 3 && first && mid && last
        ? [fmtDateShort(first.time), fmtDateShort(mid.time), fmtDateShort(last.time)]
        : last
          ? [fmtDateShort(last.time)]
          : [];

    return { candleBoxes, lineBoxes, markerViews, gridLevels, dateLabels, shownBars: n };
  }, [candles, lines, markers, plotW, plotH, maxBars, colors]);

  return (
    <View onLayout={onLayout} style={{ height }}>
      {model == null ? null : (
        <>
          <View style={{ position: 'absolute', left: 0, top: 0, width: plotW, height: plotH, overflow: 'hidden' }}>
            {model.gridLevels.map((g, k) => (
              <View
                key={`g${k}`}
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: Math.min(plotH - 1, Math.max(0, g.top)),
                  height: 1,
                  backgroundColor: colors.grid,
                }}
              />
            ))}
            {model.candleBoxes.map((b) => (
              <View
                key={b.key}
                style={{
                  position: 'absolute',
                  left: b.left,
                  top: b.top,
                  width: b.width,
                  height: b.height,
                  backgroundColor: b.color,
                }}
              />
            ))}
            {model.lineBoxes.map((b) => (
              <View
                key={b.key}
                style={{
                  position: 'absolute',
                  left: b.left,
                  top: b.top,
                  width: b.width,
                  height: b.height,
                  borderRadius: b.radius,
                  backgroundColor: b.color,
                  transform: b.rotate ? [{ rotate: `${b.rotate}rad` }] : undefined,
                }}
              />
            ))}
            {model.markerViews.map((m) =>
              m.shape === 'circle' ? (
                <View
                  key={m.key}
                  style={{
                    position: 'absolute',
                    left: m.cx - 3.5,
                    top: m.my,
                    width: 7,
                    height: 7,
                    borderRadius: 3.5,
                    backgroundColor: m.color,
                  }}
                />
              ) : (
                <View
                  key={m.key}
                  style={{
                    position: 'absolute',
                    left: m.cx - 4.5,
                    top: m.my,
                    width: 0,
                    height: 0,
                    borderLeftWidth: 4.5,
                    borderRightWidth: 4.5,
                    borderLeftColor: 'transparent',
                    borderRightColor: 'transparent',
                    ...(m.shape === 'arrowUp'
                      ? { borderBottomWidth: 7, borderBottomColor: m.color }
                      : { borderTopWidth: 7, borderTopColor: m.color }),
                  }}
                />
              )
            )}
          </View>
          {showPriceAxis ? (
            <View style={{ position: 'absolute', left: plotW, top: 0, width: AXIS_W, height: plotH }}>
              {model.gridLevels.map((g, k) => (
                <Text
                  key={`al${k}`}
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: Math.min(plotH - 12, Math.max(0, g.top - 6)),
                    fontSize: 10,
                    color: colors.text,
                  }}
                  numberOfLines={1}
                >
                  {g.label}
                </Text>
              ))}
            </View>
          ) : null}
          {showDates ? (
            <View
              style={{
                position: 'absolute',
                left: 0,
                top: plotH,
                width: plotW,
                height: DATE_H,
                flexDirection: 'row',
                justifyContent: model.dateLabels.length > 1 ? 'space-between' : 'flex-end',
              }}
            >
              {model.dateLabels.map((d, k) => (
                <Text key={`d${k}`} style={{ fontSize: 10, color: colors.text }}>
                  {d}
                </Text>
              ))}
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}
