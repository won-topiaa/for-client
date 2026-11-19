import React from 'react';
import { Text, View } from 'react-native';
import type { Candle } from '../api/types';
import { fmtDateShort, fmtPrice } from '../format';
import type { Palette } from '../theme';
import { StarButton } from './ui';

/**
 * 종목 머리 — 이름 · 종가(큰 숫자) · 전 거래일 대비.
 *
 * 왜 이렇게 바꿨나: 증권 앱(토스증권 · 로빈후드 · 레볼루트)의 종목 화면은 모두
 * '이름 → 큰 가격 → 색으로 표시한 등락' 순서로 시작한다. 사용자는 그 순서로
 * 종목 화면을 읽는 데 익숙하다. 예전 카드는 이름과 코드만 있어서, 지금 가격이
 * 이평선보다 위인지 아래인지 보려면 차트까지 내려가야 했다.
 *
 * 가격은 일봉의 마지막 두 종가로 계산한다(서버가 끝난 봉만 보내므로 '종가 기준').
 * 일봉이 없거나 한 개뿐이면 등락 줄을 그리지 않는다 — 0% 를 지어내지 않는다.
 */
export function StockHero({
  name,
  symbol,
  market,
  candles,
  watched,
  onToggleWatch,
  watchLogName,
  palette: p,
}: {
  name: string;
  symbol: string;
  market?: string | null;
  candles?: Candle[];
  watched: boolean;
  onToggleWatch: () => void;
  watchLogName?: string;
  palette: Palette;
}) {
  const last = candles && candles.length > 0 ? candles[candles.length - 1] : undefined;
  const prev = candles && candles.length > 1 ? candles[candles.length - 2] : undefined;
  const diff = last && prev ? last.close - prev.close : NaN;
  const pct = last && prev && prev.close ? (diff / prev.close) * 100 : NaN;
  const changeColor = !Number.isFinite(diff) || diff === 0 ? p.sub : diff > 0 ? p.up : p.down;
  const arrow = !Number.isFinite(diff) || diff === 0 ? '' : diff > 0 ? '▲ ' : '▼ ';
  const sign = Number.isFinite(pct) && pct > 0 ? '+' : '';

  return (
    <View style={{ paddingTop: 4, paddingBottom: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <View style={{ flexShrink: 1, paddingRight: 8 }}>
          <Text style={{ fontSize: 22, fontWeight: '700', color: p.text }} numberOfLines={1}>
            {name}
          </Text>
          <Text style={{ fontSize: 13, color: p.faint, marginTop: 2 }} numberOfLines={1}>
            {symbol}
            {market ? ` · ${market}` : ''}
          </Text>
        </View>
        <StarButton watched={watched} palette={p} label={name} logName={watchLogName} onPress={onToggleWatch} />
      </View>
      {last ? (
        <View style={{ marginTop: 14 }}>
          {/* 숫자는 고정폭 숫자로 — 종목을 바꿔 가며 볼 때 자릿수가 흔들리지 않게 */}
          <Text
            style={{ fontSize: 30, fontWeight: '700', color: p.text, fontVariant: ['tabular-nums'] }}
            accessibilityLabel={`종가 ${fmtPrice(last.close)}`}
          >
            {fmtPrice(last.close)}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: 4, gap: 6 }}>
            {Number.isFinite(diff) ? (
              <Text style={{ fontSize: 15, fontWeight: '600', color: changeColor, fontVariant: ['tabular-nums'] }}>
                {arrow}
                {fmtPrice(Math.abs(diff))} ({sign}
                {pct.toFixed(2)}%)
              </Text>
            ) : null}
            <Text style={{ fontSize: 13, color: p.faint }}>
              {Number.isFinite(diff) ? '전 거래일 대비 · ' : ''}
              {fmtDateShort(last.time)} 종가
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}
