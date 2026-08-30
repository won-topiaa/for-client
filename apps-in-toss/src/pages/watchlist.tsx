import { createRoute } from '@granite-js/react-native';
import React from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Card, Footer, StarButton } from '../components/ui';
import { pendingAnalyze } from '../store';
import { usePalette } from '../theme';
import { useWatchlist } from '../watchlist';

export const Route = createRoute('/watchlist', {
  component: WatchlistPage,
});

function WatchlistPage() {
  const p = usePalette();
  const navigation = Route.useNavigation();
  const { items, ready, saveBroken, remove } = useWatchlist();

  const openRadar = (symbol: string) => {
    pendingAnalyze.symbol = symbol;
    navigation.navigate('/radar');
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: p.bg }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexShrink: 1, paddingRight: 8 }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: p.text }}>관심종목</Text>
          <Text style={{ fontSize: 12, color: p.sub, marginTop: 2 }}>
            별표로 담아 둔 종목을 모아서 봐요
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => navigation.navigate('/')}
          accessibilityRole="button"
          style={{
            borderWidth: 1,
            borderColor: p.border,
            backgroundColor: p.card,
            borderRadius: 10,
            paddingVertical: 8,
            paddingHorizontal: 10,
          }}
        >
          <Text style={{ fontSize: 12, color: p.text, fontWeight: '600' }}>홈</Text>
        </TouchableOpacity>
      </View>

      {saveBroken ? (
        <Card palette={p} style={{ gap: 4, borderColor: p.amber, backgroundColor: p.warnBg }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
            ⚠ 관심종목이 저장되지 않아요
          </Text>
          <Text style={{ fontSize: 12, color: p.sub, lineHeight: 18 }}>
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
                  <Text style={{ fontSize: 15, fontWeight: '700', color: p.text }} numberOfLines={1}>
                    {it.name}
                  </Text>
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
          <Text style={{ fontSize: 11, color: p.faint, lineHeight: 17 }}>
            관심종목은 이 기기에만 저장돼요. 앱을 지우거나 기기를 바꾸면 목록도 사라집니다.
          </Text>
        </>
      )}

      <Footer palette={p} />
    </ScrollView>
  );
}
