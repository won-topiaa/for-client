import { createRoute } from '@granite-js/react-native';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { fetchTouches } from '../api/client';
import type { Market } from '../api/types';
import { TabBar, TAB_BAR_SPACER } from '../components/TabBar';
import {
  Badge,
  Card,
  Footer,
  PageHeader,
  PrimaryButton,
  RowDivider,
  StarButton,
} from '../components/ui';
import { SCREENER_REFRESH_HOUR_KST, SCREENER_REFRESH_MIN_KST } from '../env';
import { pendingAnalyze } from '../store';
import { GUTTER, usePalette } from '../theme';
import { useWatchlist } from '../watchlist';

export const Route = createRoute('/watchlist', {
  component: WatchlistPage,
});

const MARKETS: Market[] = ['kr', 'us'];

// 받아 둔 결과를 화면 밖(모듈)에 들고 있는다.
//
// 왜: /api/touches 응답에는 매치마다 캔들 40봉이 통째로 들어 있다. 배지에
// 필요한 건 종목코드뿐인데, 탭바로 관심종목을 드나들 때마다 그 큰 응답을 두 번
// (국내·미국) 새로 받으면 휴대폰 데이터만 축낸다.
//
// 유효기간을 '몇 분'이 아니라 **갱신 시각 기준 날짜**로 잡는다. 원본은 06:30 KST
// 에 하루 한 번 새로 계산되고 종일 고정이므로, 그 경계만 넘지 않으면 아무리
// 재사용해도 낡지 않는다. 반대로 분 단위 TTL 을 쓰면 06:20 에 채운 캐시가
// 06:50 까지 살아남아, 같은 앱에서 '오늘의 지지선' 화면은 오늘 것을 보여주는데
// 관심종목 배지만 어제 것을 보여주는 불일치가 생긴다.
let touchedCache: { day: string; map: Map<string, number> } | null = null;

/** 스크리너 갱신(06:30 KST) 기준의 '오늘' 키. 그 시각을 넘기면 값이 바뀐다. */
function refreshDayKey(): string {
  const kstNow = Date.now() + 9 * 60 * 60 * 1000;   // UTC → KST
  const shifted =
    kstNow - (SCREENER_REFRESH_HOUR_KST * 60 + SCREENER_REFRESH_MIN_KST) * 60 * 1000;
  return new Date(shifted).toISOString().slice(0, 10);
}

/**
 * 오늘 검증된 지지선에 닿은 종목 → 그 선의 기간(MA 60 등). 기간이 0 이면 닿은 건
 * 맞지만 상위 목록(matches) 밖이라 어느 선인지 모르는 종목이다.
 *
 * 담아 두기만 하고 끝나던 화면에 '오늘 이 종목이 지지선에 닿았나'를 들여온다.
 * 읽는 곳은 '오늘의 지지선'과 같은 결과(06:30 KST 에 하루 한 번 스캔해 고정)
 * 라서, 여기서 본다고 스캔이 다시 돌거나 DB 를 건드리는 일은 없다.
 *
 * 실패는 조용히 넘긴다 — 배지는 덤이라, 못 받았다고 관심종목 목록 자체를
 * 못 쓰게 만들 이유가 없다.
 */
function useTouchedToday(): Map<string, number> {
  const [touched, setTouched] = useState<Map<string, number>>(() => {
    const today = refreshDayKey();
    return touchedCache?.day === today ? touchedCache.map : new Map();
  });

  useEffect(() => {
    const today = refreshDayKey();
    if (touchedCache?.day === today) {
      return;                      // 오늘 것을 이미 받아 뒀다 — 원본이 고정이라 그대로 쓴다
    }
    let alive = true;
    void (async () => {
      const results = await Promise.allSettled(MARKETS.map((m) => fetchTouches(m)));
      if (!alive) {
        return;
      }
      const found = new Map<string, number>();
      // 두 시장 모두 '오늘 것'을 끝까지 받았는가. 06:30 직후엔 어제 결과를 보여 주며
      // 다시 훑는 중(refreshing)이거나 일부만 훑은(partial) 결과가 온다 — 그걸 오늘 것으로
      // 캐시하면 그날 내내 어제 배지가 남는다. 한 시장이라도 덜 끝났으면 보여 주기만 한다.
      let settled = true;
      for (const r of results) {
        if (r.status !== 'fulfilled') {
          settled = false;
          continue;
        }
        if (r.value.status !== 'done' || r.value.refreshing || r.value.partial) {
          settled = false;
        }
        // 상위 목록 밖에서 닿은 종목 — 선 기간은 모르지만 닿은 건 맞다
        for (const sym of r.value.touchedSymbols ?? []) {
          if (!found.has(sym)) {
            found.set(sym, 0);
          }
        }
        // 스캔이 아직 돌고 있으면(status !== 'done') matches 가 없다 — 그냥 건너뛴다
        for (const m of r.value.matches ?? []) {
          // 같은 종목이 여러 선에 닿았으면 더 긴(=보통 더 의미 있는) 선을 남긴다
          const prev = found.get(m.symbol);
          if (!prev || m.period > prev) {
            found.set(m.symbol, m.period);
          }
        }
      }
      // 덜 끝났으면 캐시하지 않는다. 캐시는 '오늘 하루' 유효하므로, 덜 된 결과를
      // 넣어 버리면 06:30 재스캔 직후에 들어온 사람은 그날 내내 배지를 못 본다
      // — 다음에 들어올 때 다시 받게 둔다.
      if (settled) {
        touchedCache = { day: today, map: found };
      }
      setTouched(found);
    })();
    return () => {
      alive = false;
    };
  }, []);

  return touched;
}

function WatchlistPage() {
  const p = usePalette();
  const navigation = Route.useNavigation();
  const { items, ready, saveBroken, remove } = useWatchlist();
  const touched = useTouchedToday();

  const openRadar = (symbol: string) => {
    pendingAnalyze.symbol = symbol;
    navigation.navigate('/radar');
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: p.bg }}
        contentContainerStyle={{
          paddingHorizontal: GUTTER,
          paddingBottom: TAB_BAR_SPACER,
          gap: 12,
        }}
      >
        {/* 우상단 '홈' 버튼은 하단 탭바로 대체했다 — 같은 이동을 두 군데 두면
            어디를 눌러야 할지 고민만 늘린다 */}
        <PageHeader title="관심종목" subtitle="별표로 담아 둔 종목을 모아서 봐요" palette={p} />

        {saveBroken ? (
          <Card palette={p} style={{ gap: 6, backgroundColor: p.warnBg }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: p.text }}>
              ⚠ 관심종목이 저장되지 않아요
            </Text>
            <Text style={{ fontSize: 13.5, color: p.sub, lineHeight: 21 }}>
              이 기기의 저장소를 쓸 수 없어서, 지금 담는 종목은 앱을 껐다 켜면 사라집니다. 토스
              앱을 최신 버전으로 올린 뒤 다시 시도해 주세요.
            </Text>
          </Card>
        ) : null}

        {!ready ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }}>
            <ActivityIndicator color={p.primary} />
            <Text style={{ fontSize: 14, color: p.sub }}>관심종목 불러오는 중…</Text>
          </View>
        ) : items.length === 0 ? (
          <Card palette={p} style={{ gap: 14 }}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: p.text }}>
              아직 담은 종목이 없어요
            </Text>
            <Text style={{ fontSize: 14, color: p.sub, lineHeight: 22 }}>
              &apos;내 종목 이평선&apos;이나 &apos;오늘의 지지선&apos; 화면에서 종목 오른쪽 위의 ☆
              를 누르면 여기에 모입니다.
            </Text>
            <PrimaryButton
              label="종목 분석하러 가기"
              palette={p}
              onPress={() => navigation.navigate('/radar')}
            />
            <PrimaryButton
              label="오늘의 지지선 보기"
              tone="secondary"
              palette={p}
              onPress={() => navigation.navigate('/screener')}
            />
          </Card>
        ) : (
          <>
            <Text style={{ fontSize: 12, color: p.faint }}>
              {items.length}개 · 누르면 이평선을 분석해요
            </Text>
            {/* 한 장의 카드에 행을 쌓는다 — 토스의 목록과 같은 모양이라,
                종목이 늘어도 화면이 카드 더미로 쪼개지지 않는다 */}
            <Card palette={p} style={{ padding: 0, overflow: 'hidden' }}>
              {items.map((it, i) => (
                <View key={it.symbol}>
                  {i === 0 ? null : <RowDivider palette={p} inset={20} />}
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    {/* 행 본문 전체가 분석 버튼 — 별은 그 바깥이라 눌러도 이동하지 않는다 */}
                    <TouchableOpacity
                      onPress={() => openRadar(it.symbol)}
                      accessibilityRole="button"
                      accessibilityLabel={`${it.name} 이평선 분석`}
                      activeOpacity={0.6}
                      style={{ flex: 1, paddingVertical: 16, paddingLeft: 20, paddingRight: 4 }}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text
                          style={{
                            fontSize: 16,
                            fontWeight: '700',
                            color: p.text,
                            flexShrink: 1,
                          }}
                          numberOfLines={1}
                        >
                          {it.name}
                        </Text>
                        {/* 오늘 검증된 지지선에 닿은 종목 — 담아만 두는 목록에서
                            '지금 볼 만한 것'이 바로 눈에 띄게 한다 */}
                        {touched.has(it.symbol) ? (
                          <Badge
                            label={touched.get(it.symbol) ? `오늘 지지선 · MA ${touched.get(it.symbol)}` : '오늘 지지선'}
                            palette={p}
                            tone="primary"
                          />
                        ) : null}
                      </View>
                      <Text style={{ fontSize: 13, color: p.faint, marginTop: 3 }}>
                        {it.symbol}
                        {it.market ? ` · ${it.market}` : ''}
                      </Text>
                    </TouchableOpacity>
                    {/* 별을 빼는 건 되돌릴 수 없다 — 옆 '분석' 영역과 충분히 떼어
                        놓아야 잘못 눌러 목록에서 사라지지 않는다 (별의 hitSlop 이
                        좌측으로 10 뻗는다). */}
                    <View style={{ paddingRight: 20, paddingLeft: 18 }}>
                      <StarButton
                        watched
                        palette={p}
                        label={it.name}
                        onPress={() => void remove(it.symbol)}
                      />
                    </View>
                  </View>
                </View>
              ))}
            </Card>
            {touched.size > 0 ? (
              <Text style={{ fontSize: 12.5, color: p.faint, lineHeight: 19 }}>
                <Text style={{ color: p.primary, fontWeight: '700' }}>오늘 지지선</Text> 배지는 그
                종목이 과거에 자주 지켜진 이평선에 오늘 닿았다는 뜻이에요. 매수·매도 신호가
                아니에요.
              </Text>
            ) : null}
            <Text style={{ fontSize: 12.5, color: p.faint, lineHeight: 19 }}>
              관심종목은 이 기기에만 저장돼요. 앱을 지우거나 기기를 바꾸면 목록도 사라집니다.
            </Text>
          </>
        )}

        <Footer palette={p} />
      </ScrollView>
      <TabBar current="/watchlist" palette={p} onNavigate={(to) => navigation.navigate(to)} />
    </View>
  );
}
