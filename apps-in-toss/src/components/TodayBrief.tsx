import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { fetchToday } from '../api/client';
import type { TodayResponse } from '../api/types';
import type { Palette } from '../theme';
import { Card, TextButton } from './ui';

// 아침 브리핑 한 장 — 알림을 누르고 들어온 사람이 처음 보는 자리.
//
// 왜 홈 안에 두는가: 스마트 발송 알림은 미니앱을 '기본 진입점'으로 연다.
// 착지 경로를 우리가 정할 수 없으니, 알림이 약속한 내용은 홈에 있어야 한다.
// 예전에는 "나스닥 ▲0.96% 공포탐욕 62"를 보내 놓고 앱 어디에도 그 값이
// 없었다 — 열 이유를 만들어 놓고 열었을 때 보상을 주지 않는 구조였다.
//
// 받아 온 값은 화면이 살아 있는 동안만 들고 있는다(모듈 캐시 없음). 지수는
// 장중에 계속 바뀌므로 오래 재사용할 값이 아니다.

/** "26,333 ▲0.96%" → 숫자와 등락을 나눠 등락만 색칠한다. */
function IndexRow({ label, value, palette: p }: { label: string; value: string; palette: Palette }) {
  const sp = value.indexOf(' ');
  const head = sp > 0 ? value.slice(0, sp) : value;
  const tail = sp > 0 ? value.slice(sp + 1) : '';
  // ▲/▼ 가 붙은 항목만 등락색. 공포탐욕("62 탐욕")처럼 화살표가 없으면 본문색.
  const tone = tail.startsWith('▲') ? p.up : tail.startsWith('▼') ? p.down : p.sub;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 7,
      }}
    >
      <Text style={{ fontSize: 14.5, color: p.sub }}>{label}</Text>
      <Text style={{ fontSize: 15, fontWeight: '700', color: p.text }} numberOfLines={1}>
        {head}
        {tail ? <Text style={{ color: tone }}>{`  ${tail}`}</Text> : null}
      </Text>
    </View>
  );
}

export function TodayBrief({
  palette: p,
  onOpenScreener,
}: {
  palette: Palette;
  onOpenScreener: () => void;
}) {
  const [body, setBody] = useState<TodayResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchToday()
      .then((res) => {
        if (alive) {
          setBody(res);
        }
      })
      .catch(() => {
        if (alive) {
          setFailed(true);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  if (failed) {
    // 브리핑은 덤이다 — 못 받았다고 홈 전체를 오류 화면으로 만들지 않는다.
    return null;
  }

  const vars = body?.vars ?? {};
  const labels = Object.keys(vars);
  const support = body?.support ?? {};
  const kr = support.kr;
  const us = support.us;
  const counted = [
    kr?.total != null ? `국내 ${kr.total}개` : null,
    us?.total != null ? `미국 ${us.total}개` : null,
  ].filter(Boolean);
  const scanning = (kr && kr.status !== 'done') || (us && us.status !== 'done');

  return (
    <Card palette={p} style={{ gap: 4 }}>
      <View
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
      >
        <Text style={{ fontSize: 17, fontWeight: '700', color: p.text }}>오늘의 시장</Text>
        {body?.asOf ? (
          <Text style={{ fontSize: 12, color: p.faint }}>
            {body.asOf} 기준{body.asOfMixed ? ' (혼합)' : ''}
          </Text>
        ) : null}
      </View>

      {body == null ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10 }}>
          <ActivityIndicator color={p.primary} />
          <Text style={{ fontSize: 13.5, color: p.sub }}>오늘 시장을 불러오는 중…</Text>
        </View>
      ) : labels.length === 0 ? (
        <Text style={{ fontSize: 13.5, color: p.sub, lineHeight: 21, paddingVertical: 6 }}>
          지금은 지수를 불러올 수 없어요. 잠시 후 다시 열어 주세요.
        </Text>
      ) : (
        <View style={{ marginTop: 2 }}>
          {labels.map((label, i) => (
            <View key={label}>
              {i === 0 ? null : <View style={{ height: 1, backgroundColor: p.border }} />}
              <IndexRow label={label} value={vars[label] ?? ''} palette={p} />
            </View>
          ))}
        </View>
      )}

      {body?.missing && body.missing.length > 0 ? (
        <Text style={{ fontSize: 12, color: p.faint, lineHeight: 18 }}>
          오늘은 {body.missing.join('·')} 값을 받지 못했어요.
        </Text>
      ) : null}

      {/* 오늘 스캔 요약 — 개수만. 목록은 지지선 화면에서 본다 */}
      {body != null ? (
        <View
          style={{
            marginTop: 10,
            paddingTop: 12,
            borderTopWidth: 1,
            borderTopColor: p.border,
            gap: 8,
          }}
        >
          <Text style={{ fontSize: 13.5, color: p.sub, lineHeight: 21 }}>
            {counted.length > 0
              ? `오늘 검증된 지지선에 닿은 종목 · ${counted.join(' · ')}`
              : scanning
                ? '오늘 지지선을 계산하는 중이에요 — 잠시 후 다시 열어 주세요.'
                : '오늘 지지선 결과를 불러오지 못했어요.'}
          </Text>
          {counted.length > 0 ? (
            <TextButton label="오늘의 지지선 보기 →" palette={p} onPress={onOpenScreener} />
          ) : null}
          {body.refreshAtKst ? (
            <Text style={{ fontSize: 12, color: p.faint }}>
              매일 아침 {body.refreshAtKst}에 새로 계산해요
            </Text>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}
