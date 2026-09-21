import { createRoute } from '@granite-js/react-native';
import React, { useRef, useState } from 'react';
import {
  Animated,
  Linking,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { TabBar, TAB_BAR_HEIGHT, TAB_BAR_SPACER } from '../components/TabBar';
import { Card, Footer, InlineToggle, PrimaryButton } from '../components/ui';
import { PUSH_TIME_LABEL } from '../env';
import { isPushAvailable } from '../notify';
import { CONTACT_EMAIL } from '../env';
import { usePalette } from '../theme';

export const Route = createRoute('/', {
  component: HomePage,
});

// 인트로 한 장의 높이 = 화면 높이 × 이 비율.
//
// 예전엔 한 장이 화면 전체(1.0)라 기능 카드까지 두 화면을 스크롤해야 했다.
// 연출은 남기되 지나가는 시간을 줄이려고 비율만 낮춘다 — 0.55 면 두 장을
// 합쳐도 한 화면 남짓이라 체감 스크롤이 절반 가까이 짧아진다.
// (작은 기기에서 제목·부제가 눌리지 않게 최소 높이를 함께 둔다)
const INTRO_RATIO = 0.55;
const INTRO_MIN_H = 300;

function IntroSection({
  scrollY,
  sectionH,
  index,
  children,
}: {
  scrollY: Animated.Value;
  /** 이 장의 높이. 페이드·이동 타이밍도 전부 이 값을 기준으로 잡는다 —
   *  높이만 줄이고 기준을 화면 높이로 두면 연출이 스크롤과 어긋난다. */
  sectionH: number;
  index: number;
  children: React.ReactNode;
}) {
  const start = index * sectionH;

  const opacity = scrollY.interpolate({
    inputRange: [
      start - sectionH * 0.3,
      start,
      start + sectionH * 0.45,
      start + sectionH * 0.8,
    ],
    outputRange: [0, 1, 1, 0],
    extrapolate: 'clamp',
  });

  const translateY = scrollY.interpolate({
    inputRange: [start - sectionH * 0.3, start, start + sectionH * 0.8],
    outputRange: [36, 0, -36],
    extrapolate: 'clamp',
  });

  const scale = scrollY.interpolate({
    inputRange: [start, start + sectionH * 0.8],
    outputRange: [1, 0.92],
    extrapolate: 'clamp',
  });

  return (
    <View style={{ height: sectionH, justifyContent: 'center', alignItems: 'center' }}>
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

function ScrollHint({ scrollY, sectionH, palette: p }: { scrollY: Animated.Value; sectionH: number; palette: ReturnType<typeof usePalette> }) {
  const opacity = scrollY.interpolate({
    inputRange: [0, sectionH * 0.2],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  return (
    <Animated.View
      style={{
        position: 'absolute',
        // 하단 탭바 위로 띄운다 — 48 그대로면 탭바에 가려 읽히지 않는다
        bottom: TAB_BAR_HEIGHT + 32,
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
  // 설명은 기본으로 접어 둔다 — 처음 열었을 때 각 기능의 '무엇을 하는지' 와
  // 버튼이 먼저 보이고, 더 알고 싶은 사람만 펼치게.
  const [radarOpen, setRadarOpen] = useState(false);
  const [screenerOpen, setScreenerOpen] = useState(false);
  const [patternsOpen, setPatternsOpen] = useState(false);
  // 인트로 한 장의 높이. 화면을 꽉 채우는 대신 절반 남짓만 쓴다 — 연출은
  // 그대로 두고 기능 카드까지 내려오는 거리를 줄이기 위해서다.
  const sectionH = Math.max(INTRO_MIN_H, screenH * INTRO_RATIO);

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <Animated.ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: TAB_BAR_SPACER }}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true },
        )}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Intro 1: 나에게 맞는 이평선 ── */}
        <IntroSection scrollY={scrollY} sectionH={sectionH} index={0}>
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
        <IntroSection scrollY={scrollY} sectionH={sectionH} index={1}>
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
            {/* 두 줄 안에 들어가야 한다 — 시스템 글자 크기를 키우면 세 번째
                줄로 넘어가 가운데 정렬이 어색해진다. '이평선' 은 바로 위 제목이
                말해 주므로 뺀다. */}
            일봉 3년 · 주봉 7년 · 월봉 전체{'\n'}백테스트로 검증된 선만 찾아드려요
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

          {/* ── 기능 1: 내 종목 이평선 ──
              카드 전체를 누르면 이동하던 구조를 없앴다. 긴 설명과 '이동' 이
              같은 터치 영역에 겹쳐 있어 어디를 눌러야 하는지 알기 어려웠다.
              이제 카드 안의 탭 대상은 '설명 보기' 와 '분석하기' 둘뿐이고,
              설명은 기본으로 접어 둬 핵심 동작이 먼저 보인다. */}
          <Card palette={p} style={{ gap: 12, borderColor: p.up, borderWidth: 1.5 }}>
            <View>
              <Text style={{ fontSize: 18, fontWeight: '800', color: p.text }}>
                내 종목 이평선
              </Text>
              <Text style={{ fontSize: 12.5, color: p.sub, marginTop: 4, lineHeight: 19 }}>
                종목을 검색하면 그 종목이 실제로 지켜온 이평선을 찾아드려요
              </Text>
            </View>
            <PrimaryButton
              label="종목 분석하기"
              palette={p}
              onPress={() => navigation.navigate('/radar')}
            />
            <InlineToggle
              open={radarOpen}
              label="설명"
              palette={p}
              onPress={() => setRadarOpen((v) => !v)}
            />
            {radarOpen ? (
              <View style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Text style={{ fontSize: 20 }}>🔍</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
                      종목을 검색하세요
                    </Text>
                    <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19, marginTop: 2 }}>
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
                    <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19, marginTop: 2 }}>
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
                    <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19, marginTop: 2 }}>
                      남들이 쓰는 20·60일선이 아니라, 이 종목이 실제로 지켜온 선을
                      확인하세요. 차트 마커로 과거 반응도 한눈에 볼 수 있어요.
                    </Text>
                  </View>
                </View>
              </View>
            ) : null}
          </Card>

          {/* ── 기능 2: 오늘의 지지선 ── */}
          <Card palette={p} style={{ gap: 12, borderColor: p.amber, borderWidth: 1.5 }}>
            <View>
              <Text style={{ fontSize: 18, fontWeight: '800', color: p.text }}>
                오늘의 지지선
              </Text>
              <Text style={{ fontSize: 12.5, color: p.sub, marginTop: 4, lineHeight: 19 }}>
                검증된 지지선에 오늘 가격이 닿은 종목만 모아 보여드려요
              </Text>
            </View>
            <PrimaryButton
              label="오늘의 지지선 보기"
              palette={p}
              color={p.amber}
              onPress={() => navigation.navigate('/screener')}
            />
            <InlineToggle
              open={screenerOpen}
              label="설명"
              palette={p}
              onPress={() => setScreenerOpen((v) => !v)}
            />
            {screenerOpen ? (
              <View style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Text style={{ fontSize: 20 }}>🚨</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
                      매일 주요 종목을 스캔해요
                    </Text>
                    <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19, marginTop: 2 }}>
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
                    <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19, marginTop: 2 }}>
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
                    <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19, marginTop: 2 }}>
                      장 마감 후 확인하면 오늘 검증된 지지선에 닿은 종목이 한눈에
                      보여요. 성공률과 차트로 매수 타이밍을 판단해 보세요.
                    </Text>
                  </View>
                </View>
              </View>
            ) : null}
          </Card>

          {/* ── 기능 3: 차트 패턴 ── */}
          <Card palette={p} style={{ gap: 12, borderColor: p.indigo, borderWidth: 1.5 }}>
            <View>
              <Text style={{ fontSize: 18, fontWeight: '800', color: p.text }}>
                차트 패턴
              </Text>
              <Text style={{ fontSize: 12.5, color: p.sub, marginTop: 4, lineHeight: 19 }}>
                교과서 속 차트 모양을 지금 만들고 있는 종목을 찾아드려요
              </Text>
            </View>
            <PrimaryButton
              label="차트 패턴 보기"
              palette={p}
              color={p.indigo}
              onPress={() => navigation.navigate('/patterns')}
            />
            <InlineToggle
              open={patternsOpen}
              label="설명"
              palette={p}
              onPress={() => setPatternsOpen((v) => !v)}
            />
            {patternsOpen ? (
              <View style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Text style={{ fontSize: 20 }}>📈</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
                      초기 상승추세
                    </Text>
                    <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19, marginTop: 2 }}>
                      바닥에서 오래 눌려 있다가 이제 막 위로 방향을 튼 종목을 찾아요.
                      이미 많이 오른 종목이 아니라 '막 출발한' 구간이에요.
                    </Text>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Text style={{ fontSize: 20 }}>📐</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
                      삼각수렴 · 컵앤핸들
                    </Text>
                    <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19, marginTop: 2 }}>
                      변동폭이 점점 좁아지는 모양, U자로 회복한 뒤 살짝 눌린 모양처럼
                      잘 알려진 패턴을 기하학적으로 맞춰봅니다.
                    </Text>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Text style={{ fontSize: 20 }}>💡</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
                      투자에 이렇게 써보세요
                    </Text>
                    <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19, marginTop: 2 }}>
                      차트에 패턴의 보조선(넥라인·추세선)을 같이 그려드려요. 모양이
                      맞는지 눈으로 확인하고 관심종목에 담아 두세요.
                    </Text>
                  </View>
                </View>
              </View>
            ) : null}
          </Card>

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
              <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19 }}>
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

          {/* ── 아침 시장 알림 ── */}
          {/* 템플릿 코드가 없으면 카드를 아예 내보내지 않는다 — 눌러도 동의
              화면이 열리지 않는 스위치는 사용자에게도 심사자에게도 고장이다.
              (src/env.ts PUSH_TEMPLATE_CODE 를 채우면 나타난다) */}
          {isPushAvailable() ? (
            <TouchableOpacity
              onPress={() => navigation.navigate('/notify')}
              accessibilityRole="button"
              activeOpacity={0.7}
            >
              <Card palette={p} style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={{ fontSize: 17 }}>🔔</Text>
                  <Text style={{ fontSize: 16, fontWeight: '800', color: p.text }}>
                    아침 시장 알림
                  </Text>
                </View>
                <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19 }}>
                  {PUSH_TIME_LABEL}, 주요 지수와 미국 공포탐욕지수를 한 줄로 보내 드려요.
                  알림을 누르면 나스닥 · 코스피 · S&amp;P500 · 공포탐욕을 모두 볼 수 있어요.
                </Text>
                <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                  <Text style={{ fontSize: 13, color: p.indigo, fontWeight: '700' }}>
                    알림 설정 →
                  </Text>
                </View>
              </Card>
            </TouchableOpacity>
          ) : null}

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
      <ScrollHint scrollY={scrollY} sectionH={sectionH} palette={p} />

      <TabBar current="/" palette={p} onNavigate={(to) => navigation.navigate(to)} />
    </View>
  );
}
