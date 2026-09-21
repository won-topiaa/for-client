import { createRoute } from '@granite-js/react-native';
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Linking,
  ScrollView,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { TabBar, TAB_BAR_HEIGHT, TAB_BAR_SPACER } from '../components/TabBar';
import {
  Card,
  Chevron,
  Expandable,
  Footer,
  InlineToggle,
  MenuRow,
  PageHeader,
  RowDivider,
} from '../components/ui';
import { CONTACT_EMAIL, PUSH_TIME_LABEL } from '../env';
import { LOG } from '../analytics';
import { isPushAvailable } from '../notify';
import { ACCENT, GUTTER, RADIUS, usePalette, type AccentKey, type Palette } from '../theme';

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

/**
 * 첫 화면의 단 하나의 행동 — 누르면 기능 목록까지 바로 내려간다.
 *
 * 예전에는 'SCROLL ↓' 안내 글자였다. 인트로를 매번 보여 주는 구조라, 앱을
 * 열자마자 보이는 화면에 누를 수 있는 것이 하나도 없다는 뜻이었다. 연출은
 * 그대로 두고, 기다리기 싫은 사람은 한 번 눌러 건너뛸 수 있게 한다.
 *
 * pointerEvents 를 상태로 껐다 켜는 이유: 스크롤하면 투명해지지만 그 자리에
 * 그대로 남아 있어서, 끄지 않으면 보이지도 않는 버튼이 화면 아래쪽 스와이프를
 * 가로챈다.
 */
function ScrollHint({
  scrollY,
  sectionH,
  palette: p,
  onPress,
}: {
  scrollY: Animated.Value;
  sectionH: number;
  palette: Palette;
  onPress: () => void;
}) {
  const [active, setActive] = useState(true);

  const opacity = scrollY.interpolate({
    inputRange: [0, sectionH * 0.2],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  useEffect(() => {
    const id = scrollY.addListener(({ value }) => {
      const on = value < sectionH * 0.2;
      setActive((prev) => (prev === on ? prev : on));
    });
    return () => scrollY.removeListener(id);
  }, [scrollY, sectionH]);

  return (
    <Animated.View
      pointerEvents={active ? 'auto' : 'none'}
      style={{
        position: 'absolute',
        // 하단 탭바 위로 띄운다 — 48 그대로면 탭바에 가려 읽히지 않는다
        bottom: TAB_BAR_HEIGHT + 28,
        alignSelf: 'center',
        opacity,
      }}
    >
      <TouchableOpacity
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel="기능 목록으로 이동"
        activeOpacity={0.7}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          backgroundColor: p.card,
          borderRadius: 999,
          paddingVertical: 11,
          paddingHorizontal: 20,
          // 인트로 배경 위에 떠 보이게 — 토스의 떠 있는 버튼과 같은 정도
          shadowColor: '#000000',
          shadowOpacity: 0.08,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 2 },
          elevation: 2,
        }}
      >
        <Text style={{ fontSize: 14, color: p.primary, fontWeight: '700' }}>시작하기</Text>
        <View accessibilityElementsHidden importantForAccessibility="no">
          <Chevron dir="down" color={p.primary} size={8} />
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

/** 설명 카드 안의 항목 한 줄 — 옅은 색 아이콘 칩 + 제목 + 본문 */
function Bullet({
  glyph,
  accent,
  title,
  body,
  palette: p,
}: {
  glyph: string;
  accent: AccentKey;
  title: string;
  body: string;
  palette: Palette;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 12 }}>
      <View
        style={{
          width: 30,
          height: 30,
          borderRadius: 15,
          backgroundColor: ACCENT[accent].bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ fontSize: 15 }}>{glyph}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 14, fontWeight: '700', color: p.text }}>{title}</Text>
        <Text style={{ fontSize: 13.5, color: p.sub, lineHeight: 21, marginTop: 3 }}>{body}</Text>
      </View>
    </View>
  );
}

/**
 * 기능 카드 — 위쪽 행을 누르면 그 화면으로 가고, 아래 '설명 보기'를 누르면
 * 같은 카드 안에서 설명이 펼쳐진다.
 *
 * 예전에는 기능마다 색이 다른 큰 버튼(초록·앰버·인디고)이 세로로 늘어서 있었다.
 * 토스 화면에서는 볼 수 없는 모양이고, 버튼이 셋이면 무엇이 주된 동작인지도
 * 알 수 없다. 이제 '이동'은 토스식 메뉴 행이 맡고, 색은 아이콘 칩에만 남긴다.
 */
function FeatureCard({
  title,
  desc,
  glyph,
  accent,
  palette: p,
  onPress,
  children,
}: {
  title: string;
  desc: string;
  glyph: string;
  accent: AccentKey;
  palette: Palette;
  onPress: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card palette={p} style={{ padding: 0 }}>
      <MenuRow
        title={title}
        desc={desc}
        glyph={glyph}
        accent={accent}
        palette={p}
        onPress={onPress}
        logName={LOG.openFeature}
      />
      <RowDivider palette={p} inset={20} />
      <InlineToggle
        open={open}
        label="설명"
        of={title}
        palette={p}
        onPress={() => setOpen((v) => !v)}
      />
      {open ? <View style={{ padding: 20, paddingTop: 2, gap: 16 }}>{children}</View> : null}
    </Card>
  );
}

function HomePage() {
  const p = usePalette();
  const navigation = Route.useNavigation();
  const { height: screenH } = useWindowDimensions();
  const scrollY = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef<ScrollView>(null);
  // 인트로 한 장의 높이. 화면을 꽉 채우는 대신 절반 남짓만 쓴다 — 연출은
  // 그대로 두고 기능 카드까지 내려오는 거리를 줄이기 위해서다.
  const sectionH = Math.max(INTRO_MIN_H, screenH * INTRO_RATIO);

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <Animated.ScrollView
        ref={scrollRef}
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
              fontSize: 32,
              fontWeight: '700',
              color: p.text,
              textAlign: 'center',
              lineHeight: 44,
              letterSpacing: -1,
            }}
          >
            나에게 맞는{'\n'}이평선
          </Text>
          <Text
            style={{
              fontSize: 15,
              color: p.sub,
              textAlign: 'center',
              marginTop: 14,
              lineHeight: 23,
            }}
          >
            종목마다 진짜 지켜온 선은 다릅니다
          </Text>
        </IntroSection>

        {/* ── Intro 2: 이평선 레이더 ── */}
        <IntroSection scrollY={scrollY} sectionH={sectionH} index={1}>
          <View
            style={{
              width: 60,
              height: 60,
              borderRadius: 20,
              backgroundColor: p.primaryBg,
              justifyContent: 'center',
              alignItems: 'center',
              marginBottom: 20,
            }}
          >
            <Text style={{ fontSize: 28 }}>📊</Text>
          </View>
          <Text
            style={{
              fontSize: 32,
              fontWeight: '700',
              color: p.text,
              textAlign: 'center',
              lineHeight: 44,
              letterSpacing: -1,
            }}
          >
            이평선 레이더
          </Text>
          <Text
            style={{
              fontSize: 15,
              color: p.sub,
              textAlign: 'center',
              marginTop: 14,
              lineHeight: 23,
            }}
          >
            {/* 두 줄 안에 들어가야 한다 — 시스템 글자 크기를 키우면 세 번째
                줄로 넘어가 가운데 정렬이 어색해진다. '이평선' 은 바로 위 제목이
                말해 주므로 뺀다. */}
            일봉 3년 · 주봉 7년 · 월봉 전체{'\n'}백테스트로 검증된 선만 찾아드려요
          </Text>
        </IntroSection>

        {/* ── Main content ── */}
        <View style={{ paddingHorizontal: GUTTER, gap: 12 }}>
          <PageHeader
            title="이평선 레이더"
            subtitle="종목마다 실제로 지켜진 이동평균선을 백테스트로 찾아드려요"
            palette={p}
          />

          {/* ── 기능 1: 내 종목 이평선 ── */}
          <FeatureCard
            title="내 종목 이평선"
            desc="종목을 검색하면 그 종목이 실제로 지켜온 이평선을 찾아드려요"
            glyph="📊"
            accent="blue"
            palette={p}
            onPress={() => navigation.navigate('/radar')}
          >
            <Bullet
              glyph="🔍"
              accent="blue"
              title="종목을 검색하세요"
              body="관심 종목의 이름이나 코드를 입력하면 자동으로 분석이 시작돼요. 한국·미국 주식 모두 가능합니다."
              palette={p}
            />
            <Bullet
              glyph="📊"
              accent="blue"
              title="핵심 이평선을 찾아드려요"
              body="일봉 3년·주봉 7년·월봉 전체 기간을 백테스트해서, 이 종목에서 가장 자주 지지/저항 역할을 해온 이동평균선 2~3개를 골라줍니다."
              palette={p}
            />
            <Bullet
              glyph="💡"
              accent="orange"
              title="투자에 이렇게 써보세요"
              body="남들이 쓰는 20·60일선이 아니라, 이 종목이 실제로 지켜온 선을 확인하세요. 차트 마커로 과거 반응도 한눈에 볼 수 있어요."
              palette={p}
            />
          </FeatureCard>

          {/* ── 기능 2: 오늘의 지지선 ── */}
          <FeatureCard
            title="오늘의 지지선"
            desc="검증된 지지선에 오늘 가격이 닿은 종목만 모아 보여드려요"
            glyph="📍"
            accent="red"
            palette={p}
            onPress={() => navigation.navigate('/screener')}
          >
            <Bullet
              glyph="🚨"
              accent="red"
              title="매일 주요 종목을 스캔해요"
              body="국내 거래대금 상위 종목과 미국 대형주를 매일 자동으로 백테스트합니다. 종목을 하나하나 찾아볼 필요가 없어요."
              palette={p}
            />
            <Bullet
              glyph="📍"
              accent="red"
              title="오늘 지지선에 닿은 종목만 알려줘요"
              body="3년 백테스트에서 지지 성공률 60% 이상, 반등 3회 이상인 검증된 이평선에 오늘 가격이 닿아 있는 종목만 골라줍니다."
              palette={p}
            />
            <Bullet
              glyph="💡"
              accent="orange"
              title="투자에 이렇게 써보세요"
              body="장 마감 후 확인하면 오늘 검증된 지지선에 닿은 종목이 한눈에 보여요. 성공률과 차트로 매수 타이밍을 판단해 보세요."
              palette={p}
            />
          </FeatureCard>

          {/* ── 기능 3: 차트 패턴 ── */}
          <FeatureCard
            title="차트 패턴"
            desc="교과서 속 차트 모양을 지금 만들고 있는 종목을 찾아드려요"
            glyph="📐"
            accent="violet"
            palette={p}
            onPress={() => navigation.navigate('/patterns')}
          >
            <Bullet
              glyph="📈"
              accent="violet"
              title="초기 상승추세"
              body="바닥에서 오래 눌려 있다가 이제 막 위로 방향을 튼 종목을 찾아요. 이미 많이 오른 종목이 아니라 '막 출발한' 구간이에요."
              palette={p}
            />
            <Bullet
              glyph="📐"
              accent="violet"
              title="삼각수렴 · 컵앤핸들"
              body="변동폭이 점점 좁아지는 모양, U자로 회복한 뒤 살짝 눌린 모양처럼 잘 알려진 패턴을 기하학적으로 맞춰봅니다."
              palette={p}
            />
            <Bullet
              glyph="💡"
              accent="orange"
              title="투자에 이렇게 써보세요"
              body="차트에 패턴의 보조선(넥라인·추세선)을 같이 그려드려요. 모양이 맞는지 눈으로 확인하고 관심종목에 담아 두세요."
              palette={p}
            />
          </FeatureCard>

          {/* ── 관심종목 · 아침 알림 ──
              한 카드에 메뉴 행으로 묶는다. 토스에서 부가 기능이 놓이는 자리와
              같은 모양이라, 위의 '기능 카드'와 무게 차이가 눈에 보인다. */}
          <Card palette={p} style={{ padding: 0 }}>
            <MenuRow
              title="관심종목"
              desc="종목 오른쪽 위의 ☆ 를 누르면 여기에 모여요"
              glyph="★"
              accent="orange"
              palette={p}
              onPress={() => navigation.navigate('/watchlist')}
              logName={LOG.openFeature}
            />
            {/* 템플릿 코드가 없으면 행을 아예 내보내지 않는다 — 눌러도 동의
                화면이 열리지 않는 스위치는 사용자에게도 심사자에게도 고장이다.
                (src/env.ts PUSH_TEMPLATE_CODE 를 채우면 나타난다) */}
            {isPushAvailable() ? (
              <>
                <RowDivider palette={p} />
                <MenuRow
                  title="아침 시장 알림"
                  desc={`${PUSH_TIME_LABEL}, 주요 지수와 공포탐욕지수를 한 줄로 보내 드려요`}
                  glyph="🔔"
                  accent="green"
                  palette={p}
                  onPress={() => navigation.navigate('/notify')}
                  logName={LOG.openFeature}
                />
              </>
            ) : null}
          </Card>

          {/* ── 이평선이란? ── */}
          <Expandable title="이동평균선이란?" palette={p}>
            <Text style={{ fontSize: 14, color: p.sub, lineHeight: 22 }}>
              이동평균선(MA)은 과거 N일간의 평균 종가를 이은 선입니다.
              주가가 이 선 근처에서 반등하면 &apos;지지&apos;, 뚫고 내려가면
              &apos;이탈&apos;이라고 해요.
            </Text>
            <Text style={{ fontSize: 14, color: p.sub, lineHeight: 22, marginTop: 10 }}>
              이 앱은 과거 시세를 백테스트해서, 종목마다 실제로 자주 지켜진
              이평선을 자동으로 찾아줍니다. 남들이 많이 쓰는 선이 아닌, 이 종목에
              맞는 선을 알 수 있어요.
            </Text>
          </Expandable>

          {/* ── 문의·협업 ── */}
          <Card palette={p} style={{ gap: 10 }}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: p.text }}>문의 · 협업</Text>
            <Text style={{ fontSize: 14, color: p.sub, lineHeight: 22 }}>
              문의사항이나 협업 제안은 아래 이메일로 편하게 연락 주세요.
            </Text>
            <TouchableOpacity
              onPress={() =>
                void Linking.openURL(
                  `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('이평선 레이더 문의')}`,
                )
              }
              accessibilityRole="link"
              activeOpacity={0.6}
              style={{
                backgroundColor: p.sunken,
                borderRadius: RADIUS.button,
                paddingVertical: 13,
                alignItems: 'center',
              }}
            >
              <Text style={{ fontSize: 15, color: p.primary, fontWeight: '700' }}>
                {CONTACT_EMAIL}
              </Text>
            </TouchableOpacity>
          </Card>

          <Footer palette={p} />
        </View>
      </Animated.ScrollView>

      {/* ── 첫 화면의 '시작하기' (스크롤하면 사라짐) ── */}
      <ScrollHint
        scrollY={scrollY}
        sectionH={sectionH}
        palette={p}
        // 인트로 두 장을 건너뛰고 제목·기능 목록이 화면 위에 오게 한다
        onPress={() => scrollRef.current?.scrollTo({ y: sectionH * 2, animated: true })}
      />

      <TabBar current="/" palette={p} onNavigate={(to) => navigation.navigate(to)} />
    </View>
  );
}
