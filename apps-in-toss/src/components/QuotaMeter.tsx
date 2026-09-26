import React from 'react';
import { Text, View } from 'react-native';
import type { PhotoQuota } from '../api/types';
import { lh } from '../lineHeight';
import type { Palette } from '../theme';

// 오늘 남은 차트 분석 횟수 — 칸 3개 중 남은 만큼 채워 보여 준다(쓸 때마다 한 칸씩 빈다).
// 숫자는 서버가 센 값(quota)만 쓴다. 앱이 따로 세면 재설치·다른 기기에서 서로 어긋난다.
// 요금제·횟수권은 아직 없다 — 다 쓴 날에도 '내일 다시'만 안내한다(구매 유도 문구 없음).

export function QuotaMeter({
  quota,
  palette: p,
  compact = false,
}: {
  quota: PhotoQuota;
  palette: Palette;
  /** 결과 화면 맨 아래용 한 줄짜리 */
  compact?: boolean;
}) {
  const limit = Math.max(1, quota.limit);
  const left = Math.max(0, Math.min(limit, quota.left));
  const done = left === 0;
  const slots = (
    <View style={{ flexDirection: 'row', gap: 6 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: limit }, (_, i) => (
        <View
          key={i}
          style={{
            // 업로드 화면에서는 칸이 가로를 나눠 채운다(한눈에 '몇 칸 남았나'), 결과 화면은 작은 점
            ...(compact ? { width: 18, height: 6 } : { flex: 1, height: 10 }),
            borderRadius: 5,
            backgroundColor: i < left ? p.primary : p.sunken,
            borderWidth: i < left ? 0 : 1,
            borderColor: p.grid,
          }}
        />
      ))}
    </View>
  );
  const label = done
    ? `오늘 ${limit}번을 모두 썼어요. 내일 0시에 다시 ${limit}번 쓸 수 있어요.`
    : `오늘 ${limit}번 중 ${left}번 남았어요`;

  if (compact) {
    return (
      <View
        accessible
        accessibilityLabel={label}
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}
      >
        {slots}
        <Text style={{ fontSize: 13, color: done ? p.warnText : p.sub, flexShrink: 1 }}>
          {done ? '오늘 분석을 모두 썼어요 · 내일 0시에 다시' : `오늘 ${left}번 더 분석할 수 있어요`}
        </Text>
      </View>
    );
  }
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{ backgroundColor: p.card, borderRadius: 16, paddingVertical: 14, paddingHorizontal: 16, gap: 10 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Text style={{ fontSize: 15, fontWeight: '700', color: p.text, flexShrink: 1 }}>오늘 남은 차트 분석</Text>
        <Text style={{ fontSize: 15, fontWeight: '700', color: done ? p.warnText : p.primary }}>
          {left} / {limit}
        </Text>
      </View>
      {slots}
      <Text style={{ fontSize: 13, color: done ? p.warnText : p.faint, ...lh(19) }}>
        {done
          ? `오늘 ${limit}번을 모두 썼어요. 내일 0시(한국 시간)에 다시 ${limit}번 쓸 수 있어요.`
          : `하루 ${limit}번까지 쓸 수 있어요. 분석을 마칠 때마다 한 칸씩 줄고, 매일 0시에 다시 채워져요.`}
      </Text>
    </View>
  );
}
