import { createRoute } from '@granite-js/react-native';
import React, { useRef } from 'react';
import {
  Animated,
  Linking,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Card, Footer } from '../components/ui';
import { CONTACT_EMAIL } from '../env';
import { usePalette } from '../theme';

export const Route = createRoute('/', {
  component: HomePage,
});

function IntroSection({
  scrollY,
  screenH,
  index,
  children,
}: {
  scrollY: Animated.Value;
  screenH: number;
  index: number;
  children: React.ReactNode;
}) {
  const start = index * screenH;

  const opacity = scrollY.interpolate({
    inputRange: [
      start - screenH * 0.3,
      start,
      start + screenH * 0.45,
      start + screenH * 0.8,
    ],
    outputRange: [0, 1, 1, 0],
    extrapolate: 'clamp',
  });

  const translateY = scrollY.interpolate({
    inputRange: [start - screenH * 0.3, start, start + screenH * 0.8],
    outputRange: [36, 0, -36],
    extrapolate: 'clamp',
  });

  const scale = scrollY.interpolate({
    inputRange: [start, start + screenH * 0.8],
    outputRange: [1, 0.92],
    extrapolate: 'clamp',
  });

  return (
    <View style={{ height: screenH, justifyContent: 'center', alignItems: 'center' }}>
      <Animated.View
        style={{
          opacity,
          transform: [{ translateY }, { scale }],
          alignItems: 'center',
          paddingHorizontal: 32,
        }}
      >
        {children}
      </Animated.View>
    </View>
  );
}

function ScrollHint({ scrollY, screenH, palette: p }: { scrollY: Animated.Value; screenH: number; palette: ReturnType<typeof usePalette> }) {
  const opacity = scrollY.interpolate({
    inputRange: [0, screenH * 0.2],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  return (
    <Animated.View
      style={{
        position: 'absolute',
        bottom: 48,
        alignSelf: 'center',
        opacity,
        alignItems: 'center',
        gap: 6,
      }}
    >
      <Text style={{ fontSize: 11, color: p.faint, letterSpacing: 1 }}>SCROLL</Text>
      <Text style={{ fontSize: 16, color: p.faint }}>↓</Text>
    </Animated.View>
  );
}

function HomePage() {
  const p = usePalette();
  const navigation = Route.useNavigation();
  const { height: screenH } = useWindowDimensions();
  const scrollY = useRef(new Animated.Value(0)).current;

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <Animated.ScrollView
        style={{ flex: 1 }}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true },
        )}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Intro 1: 나에게 맞는 이평선 ── */}
        <IntroSection scrollY={scrollY} screenH={screenH} index={0}>
          <Text
            style={{
              fontSize: 34,
              fontWeight: '800',
              color: p.text,
              textAlign: 'center',
              lineHeight: 46,
              letterSpacing: -0.5,
            }}
          >
            나에게 맞는{'\n'}이평선
          </Text>
          <Text
            style={{
              fontSize: 14,
              color: p.sub,
              textAlign: 'center',
              marginTop: 14,
              lineHeight: 22,
            }}
          >
            종목마다 진짜 지켜온 선은 다릅니다
          </Text>
        </IntroSection>

        {/* ── Intro 2: 이평선 레이더 ── */}
        <IntroSection scrollY={scrollY} screenH={screenH} index={1}>
          <View
            style={{
              width: 56,
              height: 56,
              borderRadius: 16,
              backgroundColor: p.dark ? '#18181b' : '#f4f4f5',
              borderWidth: 1,
              borderColor: p.border,
              justifyContent: 'center',
              alignItems: 'center',
              marginBottom: 20,
            }}
          >
            <Text style={{ fontSize: 26 }}>📊</Text>
          </View>
          <Text
            style={{
              fontSize: 34,
              fontWeight: '800',
              color: p.up,
              textAlign: 'center',
              lineHeight: 46,
              letterSpacing: -0.5,
            }}
          >
            이평선 레이더
          </Text>
          <Text
            style={{
              fontSize: 14,
              color: p.sub,
              textAlign: 'center',
              marginTop: 14,
              lineHeight: 22,
            }}
          >
            3년치 데이터를 백테스트해서{'\n'}검증된 이평선만 찾아드려요
          </Text>
        </IntroSection>

        {/* ── Main content ── */}
        <View style={{ padding: 16, gap: 16 }}>
          <View style={{ paddingVertical: 12 }}>
            <Text style={{ fontSize: 24, fontWeight: '800', color: p.text }}>
              이평선 레이더
            </Text>
            <Text style={{ fontSize: 13, color: p.sub, marginTop: 4, lineHeight: 20 }}>
              종목마다 실제로 지켜진 이동평균선을 백테스트로 찾아드려요
            </Text>
          </View>

          {/* ── 기능 1: 내 종목 이평선 ── */}
          <TouchableOpacity
            onPress={() => navigation.navigate('/radar')}
            accessibilityRole="button"
            activeOpacity={0.7}
          >
            <Card palette={p} style={{ gap: 12, borderColor: p.up, borderWidth: 1.5 }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: p.text }}>
                내 종목 이평선
              </Text>
              <View style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Text style={{ fontSize: 20 }}>🔍</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
                      종목을 검색하세요
                    </Text>
                    <Text style={{ fontSize: 12, color: p.sub, lineHeight: 18, marginTop: 2 }}>
                      관심 종목의 이름이나 코드를 입력하면 자동으로 분석이 시작돼요.
                      한국·미국 주식 모두 가능합니다.
                    </Text>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Text style={{ fontSize: 20 }}>📊</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
                      핵심 이평선을 찾아드려요
                    </Text>
                    <Text style={{ fontSize: 12, color: p.sub, lineHeight: 18, marginTop: 2 }}>
                      일봉 3년·주봉 7년·월봉 전체 기간을 백테스트해서, 이 종목에서 가장 자주
                      지지/저항 역할을 해온 이동평균선 2~3개를 골라줍니다.
                    </Text>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Text style={{ fontSize: 20 }}>💡</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
                      투자에 이렇게 써보세요
                    </Text>
                    <Text style={{ fontSize: 12, color: p.sub, lineHeight: 18, marginTop: 2 }}>
                      남들이 쓰는 20·60일선이 아니라, 이 종목이 실제로 지켜온 선을
                      확인하세요. 차트에서 지지/저항 마커로 과거에 어떻게 반응했는지
                      한눈에 볼 수 있어요.
                    </Text>
                  </View>
                </View>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                <Text style={{ fontSize: 13, color: p.up, fontWeight: '700' }}>
                  종목 분석하기 →
                </Text>
              </View>
            </Card>
          </TouchableOpacity>

          {/* ── 기능 2: 오늘의 지지선 ── */}
          <TouchableOpacity
            onPress={() => navigation.navigate('/screener')}
            accessibilityRole="button"
            activeOpacity={0.7}
          >
            <Card palette={p} style={{ gap: 12, borderColor: p.amber, borderWidth: 1.5 }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: p.text }}>
                오늘의 지지선
              </Text>
              <View style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Text style={{ fontSize: 20 }}>🚨</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
                      매일 주요 종목을 스캔해요
                    </Text>
                    <Text style={{ fontSize: 12, color: p.sub, lineHeight: 18, marginTop: 2 }}>
                      국내 거래대금 상위 종목과 미국 대형주를 매일 자동으로
                      백테스트합니다. 종목을 하나하나 찾아볼 필요가 없어요.
                    </Text>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Text style={{ fontSize: 20 }}>📍</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
                      오늘 지지선에 닿은 종목만 알려줘요
                    </Text>
                    <Text style={{ fontSize: 12, color: p.sub, lineHeight: 18, marginTop: 2 }}>
                      3년 백테스트에서 지지 성공률 60% 이상, 반등 3회 이상인 검증된
                      이평선에 오늘 가격이 닿아 있는 종목만 골라줍니다.
                    </Text>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Text style={{ fontSize: 20 }}>💡</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
                      투자에 이렇게 써보세요
                    </Text>
                    <Text style={{ fontSize: 12, color: p.sub, lineHeight: 18, marginTop: 2 }}>
                      장 마감 후 확인하면, 오늘 검증된 지지선 근처에서 반등 가능성이
                      있는 종목을 한눈에 볼 수 있어요. 성공률과 차트를 보고 매수
                      타이밍을 판단해 보세요.
                    </Text>
                  </View>
                </View>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                <Text style={{ fontSize: 13, color: p.amber, fontWeight: '700' }}>
                  오늘의 지지선 보기 →
                </Text>
              </View>
            </Card>
          </TouchableOpacity>

          {/* ── 관심종목 ── */}
          <TouchableOpacity
            onPress={() => navigation.navigate('/watchlist')}
            accessibilityRole="button"
            activeOpacity={0.7}
          >
            <Card palette={p} style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={{ fontSize: 17 }}>★</Text>
                <Text style={{ fontSize: 16, fontWeight: '800', color: p.text }}>관심종목</Text>
              </View>
              <Text style={{ fontSize: 12, color: p.sub, lineHeight: 18 }}>
                두 화면에서 종목 오른쪽 위의 ☆ 를 누르면 여기에 모여요. 자주 보는 종목을
                담아 두고 바로 분석해 보세요.
              </Text>
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                <Text style={{ fontSize: 13, color: p.amber, fontWeight: '700' }}>
                  관심종목 보기 →
                </Text>
              </View>
            </Card>
          </TouchableOpacity>

          {/* ── 이평선이란? ── */}
          <Card palette={p} style={{ gap: 8 }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: p.text }}>
              이동평균선이란?
            </Text>
            <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19 }}>
              이동평균선(MA)은 과거 N일간의 평균 종가를 이은 선입니다.
              주가가 이 선 근처에서 반등하면 "지지", 뚫고 내려가면 "이탈"이라고 해요.
            </Text>
            <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19 }}>
              이 앱은 과거 시세를 백테스트해서, 종목마다 실제로 자주 지켜진
              이평선을 자동으로 찾아줍니다. 남들이 많이 쓰는 선이 아닌, 이 종목에
              맞는 선을 알 수 있어요.
            </Text>
          </Card>

          {/* ── 문의·협업 ── */}
          <Card palette={p} style={{ gap: 8 }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: p.text }}>
              문의 · 협업
            </Text>
            <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19 }}>
              문의사항이나 협업 제안은 아래 이메일로 편하게 연락 주세요.
            </Text>
            <TouchableOpacity
              onPress={() => void Linking.openURL(`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('이평선 레이더 문의')}`)}
              accessibilityRole="link"
            >
              <Text style={{ fontSize: 14, color: p.indigo, fontWeight: '700' }}>
                {CONTACT_EMAIL}
              </Text>
            </TouchableOpacity>
          </Card>

          <Footer palette={p} />
        </View>
      </Animated.ScrollView>

      {/* ── 첫 화면 스크롤 힌트 (스크롤하면 사라짐) ── */}
      <ScrollHint scrollY={scrollY} screenH={screenH} palette={p} />
    </View>
  );
}
