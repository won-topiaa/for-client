import { createRoute } from '@granite-js/react-native';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { fetchTouches } from '../api/client';
import type { Market } from '../api/types';
import { TabBar, TAB_BAR_SPACER } from '../components/TabBar';
import { Card, Footer, StarButton } from '../components/ui';
import { SCREENER_REFRESH_HOUR_KST, SCREENER_REFRESH_MIN_KST } from '../env';
import { pendingAnalyze } from '../store';
import { usePalette } from '../theme';
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
 * 오늘 검증된 지지선에 닿은 종목 → 그 선의 기간(MA 60 등).
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
      let settled = false;         // 한 시장이라도 스캔을 마쳤는가
      for (const r of results) {
        if (r.status !== 'fulfilled') {
          continue;
        }
        if (r.value.status === 'done') {
          settled = true;
        }
        // 스캔이 아직 돌고 있으면(status !== 'done') matches 가 없다 — 그냥 건너뛴다
        for (const m of r.value.matches ?? []) {
          // 같은 종목이 여러 선에 닿았으면 더 긴(=보통 더 의미 있는) 선을 남긴다
          const prev = found.get(m.symbol);
          if (prev === undefined || m.period > prev) {
            found.set(m.symbol, m.period);
          }
        }
      }
      // 아직 스캔 중이었다면 캐시하지 않는다. 캐시는 '오늘 하루' 유효하므로,
      // 빈 결과를 넣어 버리면 06:30 재스캔 직후에 들어온 사람은 그날 내내
      // 배지를 못 본다 — 다음에 들어올 때 다시 받게 둔다.
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
      contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: TAB_BAR_SPACER }}
    >
      {/* 우상단 '홈' 버튼은 하단 탭바로 대체했다 — 같은 이동을 두 군데 두면
          어디를 눌러야 할지 고민만 늘린다 */}
      <View style={{ flexShrink: 1, paddingRight: 8 }}>
        <Text style={{ fontSize: 22, fontWeight: '800', color: p.text }}>관심종목</Text>
        <Text style={{ fontSize: 12, color: p.sub, marginTop: 2 }}>
          별표로 담아 둔 종목을 모아서 봐요
        </Text>
      </View>

      {saveBroken ? (
        <Card palette={p} style={{ gap: 4, borderColor: p.amber, backgroundColor: p.warnBg }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
            ⚠ 관심종목이 저장되지 않아요
          </Text>
          <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19 }}>
            이 기기의 저장소를 쓸 수 없어서, 지금 담는 종목은 앱을 껐다 켜면
            사라집니다. 토스 앱을 최신 버전으로 올린 뒤 다시 시도해 주세요.
          </Text>
        </Card>
      ) : null}

      {!ready ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }}>
          <ActivityIndicator color={p.up} />
          <Text style={{ fontSize: 13, color: p.sub }}>관심종목 불러오는 중…</Text>
        </View>
      ) : items.length === 0 ? (
        <Card palette={p} style={{ gap: 8 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: p.text }}>아직 담은 종목이 없어요</Text>
          <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19 }}>
            '내 종목 이평선'이나 '오늘의 지지선' 화면에서 종목 오른쪽 위의 ☆ 를 누르면
            여기에 모입니다.
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
            <TouchableOpacity
              onPress={() => navigation.navigate('/radar')}
              accessibilityRole="button"
              style={{
                borderWidth: 1,
                borderColor: p.up,
                borderRadius: 10,
                paddingVertical: 9,
                paddingHorizontal: 12,
              }}
            >
              <Text style={{ fontSize: 13, color: p.up, fontWeight: '700' }}>종목 분석하기 →</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => navigation.navigate('/screener')}
              accessibilityRole="button"
              style={{
                borderWidth: 1,
                borderColor: p.amber,
                borderRadius: 10,
                paddingVertical: 9,
                paddingHorizontal: 12,
              }}
            >
              <Text style={{ fontSize: 13, color: p.amber, fontWeight: '700' }}>오늘의 지지선 →</Text>
            </TouchableOpacity>
          </View>
        </Card>
      ) : (
        <>
          <Text style={{ fontSize: 11, color: p.faint }}>
            {items.length}개 · 누르면 이평선을 분석해요
          </Text>
          {items.map((it) => (
            // padding 0 — 안쪽 터치 영역이 카드 끝까지 닿도록 각자 여백을 준다
            <Card key={it.symbol} palette={p} style={{ padding: 0 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                {/* 카드 본문 전체가 분석 버튼 — 별은 그 바깥이라 눌러도 이동하지 않는다 */}
                <TouchableOpacity
                  onPress={() => openRadar(it.symbol)}
                  accessibilityRole="button"
                  accessibilityLabel={`${it.name} 이평선 분석`}
                  style={{ flex: 1, paddingVertical: 14, paddingLeft: 14, paddingRight: 4 }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text
                      style={{ fontSize: 15, fontWeight: '700', color: p.text, flexShrink: 1 }}
                      numberOfLines={1}
                    >
                      {it.name}
                    </Text>
                    {/* 오늘 검증된 지지선에 닿은 종목 — 담아만 두는 목록에서
                        '지금 볼 만한 것'이 바로 눈에 띄게 한다 */}
                    {touched.has(it.symbol) ? (
                      <View
                        style={{
                          backgroundColor: p.emeraldBg,
                          borderRadius: 6,
                          paddingVertical: 2,
                          paddingHorizontal: 6,
                          flexShrink: 0,
                        }}
                      >
                        <Text style={{ fontSize: 10, fontWeight: '700', color: p.up }}>
                          오늘 지지선 · MA {touched.get(it.symbol)}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={{ fontSize: 11, color: p.faint, marginTop: 2 }}>
                    {it.symbol}
                    {it.market ? ` · ${it.market}` : ''}
                  </Text>
                </TouchableOpacity>
                {/* 별을 빼는 건 되돌릴 수 없다 — 옆 '분석' 영역과 충분히 떼어
                    놓아야 잘못 눌러 목록에서 사라지지 않는다 (별의 hitSlop 이
                    좌측으로 10 뻗는다). */}
                <View style={{ paddingRight: 14, paddingLeft: 18 }}>
                  <StarButton
                    watched
                    palette={p}
                    label={it.name}
                    onPress={() => void remove(it.symbol)}
                  />
                </View>
              </View>
            </Card>
          ))}
          {touched.size > 0 ? (
            <Text style={{ fontSize: 11, color: p.faint, lineHeight: 17 }}>
              <Text style={{ color: p.up, fontWeight: '700' }}>오늘 지지선</Text> 배지는 그 종목이
              오늘 검증된 지지 이평선에 닿아 있다는 뜻이에요. 매수 신호가 아니라 지켜보기 좋은
              지점입니다.
            </Text>
          ) : null}
          <Text style={{ fontSize: 11, color: p.faint, lineHeight: 17 }}>
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
