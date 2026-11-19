import { Storage } from '@apps-in-toss/framework';
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
import { TodayBrief } from '../components/TodayBrief';
import {
  Card,
  Chevron,
  Footer,
  MenuRow,
  PageHeader,
  RowDivider,
  Segmented,
} from '../components/ui';
import { CONTACT_EMAIL, PUSH_TIME_LABEL } from '../env';
import { LOG } from '../analytics';
import { isPushAvailable } from '../notify';
import {
  GUTTER,
  RADIUS,
  usePalette,
  useThemeMode,
  type AccentKey,
  type Palette,
  type ThemeMode,
} from '../theme';
import { lh } from '../lineHeight';

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

// 인트로를 '오늘 이미 봤는가'로 기억하는 자리.
//
// 매번 보여 주던 것을 하루 한 번으로 줄인다. 아침 알림을 누르고 들어오는
// 사람에게는 인트로가 매일 통과해야 하는 관문이 되는데, 정작 그 사람이
// 보러 온 것(오늘의 시장)은 인트로 뒤에 있다.
//
// 경계는 KST 자정이다. 스캔 갱신 시각을 쓰면 갱신 직전·직후에 연 사람이
// 같은 아침에 두 번 보게 된다 — '오늘 이미 봤다'는 사람이 쓰는 말이라
// 달력 날짜로 세는 편이 뜻과 맞다.
const INTRO_SEEN_KEY = 'wontopia.introSeen';
/** 소개를 보여 줄지 정하려고 저장소를 기다리는 최대 시간 */
const STORAGE_WAIT_MS = 400;
const STORAGE_SLOW = '\u0000slow';

/** KST 기준 오늘 날짜 'YYYY-MM-DD'. */
function kstToday(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 'unknown' 동안에는 화면을 그리지 않는다 — 아래 주석 참고. */
type IntroState = 'unknown' | 'show' | 'skip';

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'auto', label: '자동' },
  { value: 'light', label: '라이트' },
  { value: 'dark', label: '다크' },
];

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
          // 인트로 배경 위에 '떠 있는' 조각이라 raised 를 쓴다 — 다크에서
          // 카드색을 쓰면 배경과 1.16:1 이라 버튼이 있는 줄도 모른다
          backgroundColor: p.raised,
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
}: {
  title: string;
  desc: string;
  glyph: string;
  accent: AccentKey;
  palette: Palette;
  onPress: () => void;
}) {
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
    </Card>
  );
}

function HomePage() {
  const p = usePalette();
  const { mode, setMode } = useThemeMode();
  const navigation = Route.useNavigation();
  const { height: screenH } = useWindowDimensions();
  const scrollY = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef<ScrollView>(null);
  // 인트로 한 장의 높이. 화면을 꽉 채우는 대신 절반 남짓만 쓴다 — 연출은
  // 그대로 두고 기능 카드까지 내려오는 거리를 줄이기 위해서다.
  const sectionH = Math.max(INTRO_MIN_H, screenH * INTRO_RATIO);
  const [intro, setIntro] = useState<IntroState>('unknown');

  // 오늘 이미 봤는지 확인하고, 보여 주기로 했으면 그 자리에서 '봤다'로 적는다.
  //
  // 결론이 날 때까지 화면을 그리지 않는 이유: 이것은 스크롤 맨 위의 내용이라,
  // 먼저 그려 놓고 나중에 붙이거나 떼면 사용자가 보던 자리가 통째로 밀린다.
  // 저장소 읽기 한 번이라 홈이 비어 있는 시간은 한 프레임 수준이고, 어차피
  // 브리핑은 네트워크를 기다린다.
  //
  // 읽기에 실패하면 보여 주는 쪽으로 넘어간다 — 처음 온 사람이 소개를 못 보는
  // 것이, 본 사람이 한 번 더 보는 것보다 나쁘다.
  useEffect(() => {
    let alive = true;
    void (async () => {
      let seen: string | null = null;
      try {
        // 저장소가 늦으면 기다리지 않고 소개 없이 바로 그린다 — 첫 화면을
        // 저장소 응답에 묶어 두지 않는다 (앱인토스 심사: 최초 접속 20초 이내)
        seen = await Promise.race([
          Storage.getItem(INTRO_SEEN_KEY),
          new Promise<string>((resolve) => setTimeout(() => resolve(STORAGE_SLOW), STORAGE_WAIT_MS)),
        ]);
      } catch {
        seen = null;
      }
      if (!alive) {
        return;
      }
      if (seen === STORAGE_SLOW) {
        setIntro('skip');
        return;
      }
      const today = kstToday();
      if (seen === today) {
        setIntro('skip');
        return;
      }
      setIntro('show');
      // 저장 실패는 넘긴다 — 다음에 한 번 더 보게 될 뿐이다
      void Storage.setItem(INTRO_SEEN_KEY, today).catch(() => undefined);
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (intro === 'unknown') {
    // 본문은 아직 그리지 않되 탭바는 그린다 — 절대배치라 나중에 본문이 붙어도
    // 밀리지 않고, 그 사이 앱이 멈춘 것처럼 보이지 않는다.
    return (
      <View style={{ flex: 1, backgroundColor: p.bg }}>
        <TabBar current="/" palette={p} onNavigate={(to) => navigation.navigate(to)} />
      </View>
    );
  }
  const showIntro = intro === 'show';

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
        {showIntro ? (
          <>
          {/* ── Intro 1: 나에게 맞는 이평선 ── */}
          <IntroSection scrollY={scrollY} sectionH={sectionH} index={0}>
            <Text
              style={{
                fontSize: 32,
                fontWeight: '700',
                color: p.text,
                textAlign: 'center',
                ...lh(44),
                letterSpacing: -1,
              }}
            >
              나에게 맞는{'\n'}이평선
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
                ...lh(44),
                letterSpacing: -1,
              }}
            >
              이평선 레이더
            </Text>
          </IntroSection>
          </>
        ) : null}

        {/* ── Main content ── */}
        <View style={{ paddingHorizontal: GUTTER, gap: 12 }}>
          <PageHeader title="이평선 레이더" palette={p} />

          {/* 아침 알림이 약속한 내용은 여기 있어야 한다 — 스마트 발송은
              미니앱을 기본 진입점으로 열기 때문에, 알림을 누른 사람이
              처음 닿는 곳이 이 화면이다 (components/TodayBrief 주석 참고) */}
          <TodayBrief palette={p} onOpenScreener={() => navigation.navigate('/screener')} />

          {/* ── 기능 1: 내 종목 이평선 ── */}
          <FeatureCard
            title="내 종목 이평선"
            desc="종목별 이평선 지지·저항 기록"
            glyph="📊"
            accent="blue"
            palette={p}
            onPress={() => navigation.navigate('/radar')}
          />

          {/* ── 기능 1-2: 차트 사진 분석 (1.3.5) ── */}
          <FeatureCard
            title="차트 사진 분석"
            desc="차트 사진으로 지표 한눈에 보기"
            glyph="📷"
            accent="blue"
            palette={p}
            onPress={() => navigation.navigate('/photo')}
          />

          {/* ── 기능 2: 오늘의 지지선 ── */}
          <FeatureCard
            title="오늘의 지지선"
            desc="오늘 지지선에 닿은 종목"
            glyph="📍"
            accent="red"
            palette={p}
            onPress={() => navigation.navigate('/screener')}
          />

          {/* ── 기능 3: 차트 패턴 ── */}
          <FeatureCard
            title="차트 패턴"
            desc="차트 모양별 종목"
            glyph="📐"
            accent="violet"
            palette={p}
            onPress={() => navigation.navigate('/patterns')}
          />

          {/* ── 관심종목 · 아침 알림 ──
              한 카드에 메뉴 행으로 묶는다. 토스에서 부가 기능이 놓이는 자리와
              같은 모양이라, 위의 '기능 카드'와 무게 차이가 눈에 보인다. */}
          <Card palette={p} style={{ padding: 0 }}>
            <MenuRow
              title="맞춤 이평선"
              desc="내가 고른 이평선에 닿은 종목"
              glyph="📏"
              accent="blue"
              palette={p}
              onPress={() => navigation.navigate('/lines')}
              logName={LOG.openFeature}
            />
            <RowDivider palette={p} />
            <MenuRow
              title="관심종목"
              desc="☆ 로 담아 둔 종목"
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
                  desc={`${PUSH_TIME_LABEL} 시장 지수 한 줄`}
                  glyph="🔔"
                  accent="green"
                  palette={p}
                  onPress={() => navigation.navigate('/notify')}
                  logName={LOG.openFeature}
                />
              </>
            ) : null}
          </Card>


          {/* ── 화면 테마 ──
              앱인토스 TDS 는 라이트만 안내하지만, 밤에 시세를 보는 사람에게는
              흰 화면이 더 불편하다. 기기 설정을 따르는 '자동'을 기본으로 두고,
              호스트가 기기 설정을 안 넘겨주는 경우까지 생각해 직접 고를 수도
              있게 한다. */}
          <Card palette={p} style={{ gap: 12 }}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: p.text }}>화면 테마</Text>
            <Segmented
              options={THEME_OPTIONS}
              value={mode}
              palette={p}
              onChange={(v) => setMode(v)}
            />
          </Card>
          {/* ── 문의·협업 ── */}
          <Card palette={p} style={{ gap: 10 }}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: p.text }}>문의 · 협업</Text>
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
      {showIntro ? (
        <ScrollHint
          scrollY={scrollY}
          sectionH={sectionH}
          palette={p}
          // 인트로 두 장을 건너뛰고 제목·기능 목록이 화면 위에 오게 한다
          onPress={() => scrollRef.current?.scrollTo({ y: sectionH * 2, animated: true })}
        />
      ) : null}

      <TabBar current="/" palette={p} onNavigate={(to) => navigation.navigate(to)} />
    </View>
  );
}
