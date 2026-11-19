import { Storage } from '@apps-in-toss/framework';
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { fetchToday } from '../api/client';
import type { TodayResponse } from '../api/types';
import type { Palette } from '../theme';
import { Card, TextButton } from './ui';
import { lh } from '../lineHeight';

// 아침 브리핑 한 장 — 알림을 누르고 들어온 사람이 처음 보는 자리.
//
// 왜 홈 안에 두는가: 스마트 발송 알림은 미니앱을 '기본 진입점'으로 연다.
// 착지 경로를 우리가 정할 수 없으니, 알림이 약속한 내용은 홈에 있어야 한다.
// 예전에는 "나스닥 ▲0.96% 공포탐욕 62"를 보내 놓고 앱 어디에도 그 값이
// 없었다 — 열 이유를 만들어 놓고 열었을 때 보상을 주지 않는 구조였다.
//
// 첫 화면이 서버를 기다리지 않게 한다 (앱인토스 심사: 최초 접속 20초 이내).
// 서버(Render 무료)는 쉬다가 첫 요청에 깨어나느라 수십 초가 걸린다. 그래서
// - 지난번에 받은 브리핑을 기기에 저장해 두고, 열자마자 그것부터 보여 준다
//   (제목 옆 '○○ 기준'이 그 값의 날짜라 오래된 값인지 알 수 있다).
// - 저장된 게 없으면 카드를 아예 그리지 않는다 — 스피너가 첫 화면에 남아
//   '앱이 아직 로딩 중'으로 보이지 않게. 받아 오면 그때 나타난다.
// - 실패하면 조용히 두 번 더 받아 본다(그 사이 서버가 깨어난다).
const CACHE_KEY = 'wontopia.todayCache';
const RETRY_DELAYS_MS = [4000, 12000];

async function readCache(): Promise<TodayResponse | null> {
  try {
    const raw = await Storage.getItem(CACHE_KEY);
    if (!raw) {
      return null;
    }
    const v = JSON.parse(raw) as TodayResponse;
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

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

  useEffect(() => {
    let alive = true;
    let fresh = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // 저장해 둔 값 먼저 — 새 값이 먼저 왔으면 덮지 않는다
    void readCache().then((cached) => {
      if (alive && !fresh && cached) {
        setBody(cached);
      }
    });
    const attempt = (n: number) => {
      fetchToday()
        .then((res) => {
          if (!alive) {
            return;
          }
          fresh = true;
          setBody(res);
          void Storage.setItem(CACHE_KEY, JSON.stringify(res)).catch(() => undefined);
        })
        .catch(() => {
          // 브리핑은 덤이다 — 못 받았다고 홈에 오류를 띄우지 않는다
          const delay = RETRY_DELAYS_MS[n];
          if (alive && delay != null) {
            timer = setTimeout(() => attempt(n + 1), delay);
          }
        });
    };
    attempt(0);
    return () => {
      alive = false;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  if (body == null) {
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
  // 'error' 를 'running' 과 뭉뚱그리면 실패한 스캔을 '계산하는 중'이라고
  // 말하고, 이 카드는 한 번만 받아 오므로 그 문구가 끝까지 남는다.
  const scanning = kr?.status === 'running' || us?.status === 'running';

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

      {labels.length === 0 ? null : (
        <View style={{ marginTop: 2 }}>
          {labels.map((label, i) => (
            <View key={label}>
              {i === 0 ? null : <View style={{ height: 1, backgroundColor: p.border }} />}
              <IndexRow label={label} value={vars[label] ?? ''} palette={p} />
            </View>
          ))}
        </View>
      )}

      {body.missing && body.missing.length > 0 ? (
        <Text style={{ fontSize: 12, color: p.faint, ...lh(18) }}>
          오늘은 {body.missing.join('·')} 값을 받지 못했어요.
        </Text>
      ) : null}

      {/* 오늘 스캔 요약 — 개수만. 목록은 지지선 화면에서 본다 */}
      {counted.length > 0 || scanning ? (
        <View
          style={{
            marginTop: 10,
            paddingTop: 12,
            borderTopWidth: 1,
            borderTopColor: p.border,
            gap: 8,
          }}
        >
          <Text style={{ fontSize: 13.5, color: p.sub, ...lh(21) }}>
            {counted.length > 0
              ? `오늘 지지선에 닿은 종목 · ${counted.join(' · ')}`
              : '오늘 지지선을 계산하는 중이에요.'}
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
