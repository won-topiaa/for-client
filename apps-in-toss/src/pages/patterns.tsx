import { createRoute } from '@granite-js/react-native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { ApiError, fetchPatterns, isRateLimited } from '../api/client';
import type { Market, PatternKey, PatternMatch, PatternsResponse } from '../api/types';
import { CandleChart, type ChartLine } from '../components/CandleChart';
import { WaitingShow } from '../components/WaitingShow';
import { TabBar, TAB_BAR_SPACER } from '../components/TabBar';
import {
  Card,
  Chip,
  Expandable,
  Footer,
  IconChip,
  Notice,
  PageHeader,
  PrimaryButton,
  Segmented,
  StarButton,
  TextButton,
} from '../components/ui';
import { LOG } from '../analytics';
import { pendingAnalyze } from '../store';
import { GUTTER, usePalette, type Palette } from '../theme';
import { isWatched, useWatchlist } from '../watchlist';
import { lh } from '../lineHeight';

export const Route = createRoute('/patterns', {
  component: PatternsPage,
});

type Phase = 'boot' | 'running' | 'done' | 'error';

const POLL_RUNNING_MS = 2000;
const POLL_PARTIAL_MS = 5000;
const RETRY_ERROR_MS = 15000;
const RATE_LIMIT_BACKOFF_SEC = 30;

// 패턴 카드는 4장뿐(서버가 상위 4개만 준다)이라 봉을 넉넉히 그린다.
// 서버가 주는 200봉을 자르지 않는 이유: 오버레이(넥라인·컵 테두리 등)는
// 200봉 창에 맞춰 좌표가 매겨져 있어서, 봉을 잘라내면 보조선이 중간에서
// 끊겨 패턴 모양이 깨져 보인다.
const CHART_BARS = 200;

const MARKET_OPTIONS: { value: Market; label: string }[] = [
  { value: 'kr', label: '국내' },
  { value: 'us', label: '미국' },
];

const TAIL = ' 모양이 맞는지만 보고, 앞으로의 움직임은 말하지 않아요.';

/**
 * 화면에 노출하는 패턴 — 서버(app/patterns.py PATTERN_KEYS)가 찾는 14가지 전부.
 * 설명은 생김새와 탐지 기준(지난 사실)만 쓴다. 이름 속 '상승·하락·급등·급락'은
 * 선의 기울기나 지난 움직임이지 앞으로의 방향이 아니라는 점을 detail 에 밝힌다.
 * bars: 카드 차트에 그릴 봉 수(기본 CHART_BARS). 깃발형은 최근 40봉 안의 모양이라
 * 200봉에 그리면 오른쪽 끝에 점처럼 보여, 짧게 잘라 크게 그린다(보조선이 모두 그 안에 있다).
 */
const PATTERNS: {
  key: PatternKey;
  label: string;
  emoji: string;
  plain: string;
  detail: string;
  bars?: number;
}[] = [
  {
    key: 'downtrend_break',
    label: '하락 추세선 돌파',
    emoji: '📏',
    plain: '점점 낮아지던 고점들을 이은 선(하락 추세선) 위에서 종가가 처음 마감한 모양이에요.',
    detail:
      '최근 약 9개월 안에서 점점 낮아지는 고점들을 한 줄로 이은 선을 찾아요. 선에 3번 이상 ' +
      '닿았고, 두 달(40거래일) 넘게 종가가 한 번도 선 위에서 마감하지 않다가 최근 10거래일 ' +
      '이내에 처음 선 위에서 마감한 종목이에요. 지금 종가가 선과 5% 넘게 벌어져 있거나, 선 위 ' +
      '마감 뒤 선 아래로 2% 넘게 내려간 적이 있으면 목록에서 빠져요.' + TAIL,
  },
  {
    key: 'uptrend_break',
    label: '상승 추세선 이탈',
    emoji: '✏️',
    plain: '점점 높아지던 저점들을 이은 선(상승 추세선) 아래에서 종가가 처음 마감한 모양이에요.',
    detail:
      '하락 추세선 돌파를 뒤집은 모양이에요. 점점 높아지는 저점들을 이은 선에 3번 이상 닿았고, ' +
      '두 달(40거래일) 넘게 종가가 한 번도 선 아래에서 마감하지 않다가 최근 10거래일 이내에 ' +
      '처음 선 아래에서 마감한 종목이에요. 지금 종가가 선과 5% 넘게 벌어져 있거나, 선 아래 ' +
      '마감 뒤 선 위로 2% 넘게 올라간 적이 있으면 목록에서 빠져요.' + TAIL,
  },
  {
    key: 'head_shoulders',
    label: '헤드앤숄더',
    emoji: '⛰️',
    plain: '봉우리 셋 중 가운데가 가장 높은 모양이에요. 머리와 두 어깨를 닮아 붙은 이름이에요.',
    detail:
      '왼쪽 어깨 → 머리 → 오른쪽 어깨 순으로 고점 세 개가 만들어지고, 두 번의 ' +
      '되돌림 저점을 이은 선(넥라인)이 기준이 돼요.' + TAIL,
  },
  {
    key: 'inv_head_shoulders',
    label: '역헤드앤숄더',
    emoji: '🏞️',
    plain: '헤드앤숄더를 뒤집은 모양이에요. 골짜기 셋 중 가운데가 가장 깊어요.',
    detail:
      '왼쪽 어깨 → 머리 → 오른쪽 어깨 순으로 저점 세 개가 만들어지고, 가운데(머리)가 ' +
      '가장 깊어요. 되돌림 고점 둘을 이은 선(넥라인)이 기준이 돼요.' + TAIL,
  },
  {
    key: 'double_top',
    label: '쌍봉',
    emoji: '🐫',
    plain: '비슷한 높이에서 고점을 두 번 만든 모양이에요. 낙타 등의 두 혹을 닮았어요.',
    detail:
      '두 고점의 높이 차이가 3% 안이고, 두 고점 사이에서 가장 낮았던 가격(넥라인)보다 ' +
      '10% 넘게 높은 모양을 찾아요. 넥라인 근처에 있거나, 넥라인 아래에서 마감한 지 ' +
      '10거래일 이내인 종목만 보여 줘요.' + TAIL,
  },
  {
    key: 'double_bottom',
    label: '쌍바닥',
    emoji: '👓',
    plain: '비슷한 높이에서 저점을 두 번 만든 모양이에요. 알파벳 W를 닮았어요.',
    detail:
      '쌍봉을 뒤집은 모양이에요. 두 저점의 높이 차이가 3% 안이고, 두 저점 사이에서 가장 ' +
      '높았던 가격(넥라인)보다 10% 넘게 낮은 모양을 찾아요. 넥라인 근처에 있거나, 넥라인 ' +
      '위에서 마감한 지 10거래일 이내인 종목만 보여 줘요.' + TAIL,
  },
  {
    key: 'triple_top',
    label: '삼중천장',
    emoji: '🔱',
    plain: '비슷한 높이에서 고점을 세 번 만든 모양이에요.',
    detail:
      '세 고점의 높이 차이가 3% 안에 모인 모양이에요. 가운데가 두드러지게 높으면 ' +
      '헤드앤숄더로 따로 봐요. 고점 사이 두 저점 중 더 낮은 가격을 넥라인이라고 불러요. ' +
      '같은 고점 두 개가 쌍봉으로도 보이면 여기에서만 보여 줘요.' + TAIL,
  },
  {
    key: 'triple_bottom',
    label: '삼중바닥',
    emoji: '🍡',
    plain: '비슷한 높이에서 저점을 세 번 만든 모양이에요.',
    detail:
      '삼중천장을 뒤집은 모양이에요. 세 저점의 높이 차이가 3% 안에 모여 있고, 저점 사이 ' +
      '두 고점 중 더 높은 가격을 넥라인이라고 불러요. 같은 저점 두 개가 쌍바닥으로도 보이면 ' +
      '여기에서만 보여 줘요.' + TAIL,
  },
  {
    key: 'triangle',
    label: '삼각수렴',
    emoji: '📐',
    plain: '고점은 낮아지고 저점은 높아지며 변동폭이 점점 좁아지는 모양이에요.',
    detail:
      '위아래로 흔들리던 폭이 점점 줄어 한 점으로 모이는 구간이에요. 고점을 ' +
      '이은 선은 내려오고 저점을 이은 선은 올라가, 두 선 사이가 좁아지는 ' +
      '모양을 찾아요.',
  },
  {
    key: 'wedge',
    label: '쐐기형',
    emoji: '🧀',
    plain: '위아래 두 선이 같은 쪽으로 기울면서 폭이 좁아지는 모양이에요.',
    detail:
      '고점들을 따라 그은 선과 저점들을 따라 그은 선이 둘 다 오르거나(상승 쐐기) 둘 다 ' +
      '내리며(하락 쐐기) 가까워지는 모양이에요. 이름의 상승·하락은 두 선이 기운 방향이고, ' +
      '주가 방향을 말하는 이름이 아니에요.' + TAIL,
  },
  {
    key: 'rectangle',
    label: '박스권',
    emoji: '📦',
    plain: '거의 수평인 두 선 사이를 여러 번 오간 모양이에요.',
    detail:
      '위아래 두 선이 거의 수평이고, 한 달 넘게 그 사이에서 오르내린 종목을 찾아요. ' +
      '두 선 사이의 폭은 5~35%예요. 종가가 이미 선 밖으로 크게 나갔으면 빼요.' + TAIL,
  },
  {
    key: 'flag',
    label: '깃발형',
    emoji: '🚩',
    plain: '짧은 기간 크게 움직인 구간(깃대) 뒤에, 좁은 폭 안에서 쉬어 가는 구간(깃발)이 붙은 모양이에요.',
    detail:
      '3~20거래일 동안 15% 넘게 오르거나 내린 구간(깃대) 뒤에, 5~20거래일 동안 깃대의 절반보다 ' +
      '적게 되돌리며 좁은 폭 안에서 움직이는 모양을 찾아요. 위아래 두 선의 폭이 크게 변하지 ' +
      '않으면 깃발형, 위 선은 내려오고 아래 선은 올라와 모이면 페넌트형이에요. 목록에 붙는 ' +
      '‘크게 오른 뒤·크게 내린 뒤’는 이 모양 앞의 지난 움직임(깃대)이에요.' + TAIL,
    bars: 80,
  },
  {
    key: 'cup_handle',
    label: '컵앤핸들',
    emoji: '☕',
    plain: 'U자로 완만히 회복한 뒤, 살짝 눌러 쉬어가는 모양이에요.',
    detail:
      '깊게 빠졌다가 둥근 U자를 그리며 이전 고점 근처까지 돌아온 뒤(컵), ' +
      '짧고 얕게 내려온 구간(핸들)이 붙은 형태예요. 모양이 커피잔과 손잡이를 ' +
      '닮아 붙은 이름이에요.',
  },
  {
    key: 'stage2',
    label: '초기 상승추세',
    emoji: '📈',
    plain: '오래 옆으로 움직이던 주가가 장기 이동평균선 위로 올라선 모양이에요.',
    detail:
      '오래 옆으로 움직이던 구간(박스)의 위쪽 선을 최근 넘어섰고, 150일 이동평균선 ' +
      '위에 있으며, 그 이동평균선이 최근 위를 향하기 시작한 모양을 찾아요.' + TAIL,
  },
];

/** 고르는 칸 묶음 — 14개를 한 줄로 늘어놓으면 찾기 어려워, 생김새끼리 묶는다. */
const GROUPS: { title: string; keys: PatternKey[] }[] = [
  { title: '추세선', keys: ['downtrend_break', 'uptrend_break'] },
  {
    title: '봉우리·골짜기',
    keys: ['head_shoulders', 'inv_head_shoulders', 'double_top', 'double_bottom', 'triple_top', 'triple_bottom'],
  },
  { title: '두 선 사이', keys: ['triangle', 'wedge', 'rectangle', 'flag'] },
  { title: '그 밖의 모양', keys: ['cup_handle', 'stage2'] },
];

/**
 * 매치 한 건. React.memo 인 이유는 screener 와 같다 — 관심종목이 바뀌면
 * 배열 정체성이 바뀌어 페이지가 다시 그려지는데, 카드마다 200봉 캔들차트가
 * 들어 있어 별 한 번에 수천 개 View 가 다시 배치된다.
 */
const PatternCard = React.memo(function PatternCard({
  match: m,
  palette: p,
  bars,
  watched,
  onToggleWatch,
  onOpenRadar,
}: {
  match: PatternMatch;
  palette: Palette;
  bars: number;
  watched: boolean;
  onToggleWatch: (item: { symbol: string; name: string; market?: string | null }) => void;
  onOpenRadar: (m: PatternMatch) => void;
}) {
  // 보조선은 이평선과 같은 형태({time,value})라 차트의 lines 로 그대로 넘긴다.
  const lines: ChartLine[] = (m.overlays ?? []).map((ov, i) => ({
    color: p.ma[i % p.ma.length] ?? p.primary,
    points: ov.points,
    width: 2,
  }));

  return (
    <Card palette={p} style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flexShrink: 1, paddingRight: 8 }}>
          <Text style={{ fontSize: 17, fontWeight: '700', color: p.text }} numberOfLines={1}>
            {m.name}
          </Text>
          <Text style={{ fontSize: 13, color: p.faint, marginTop: 3 }}>
            {m.symbol}
            {m.market ? ` · ${m.market}` : ''}
          </Text>
        </View>
        <StarButton
          watched={watched}
          palette={p}
          label={m.name}
          logName={LOG.watchlistAdd}
          onPress={() => onToggleWatch({ symbol: m.symbol, name: m.name, market: m.market })}
        />
      </View>

      {/* 왜 이 패턴으로 봤는지 — 서버가 만든 한 줄 */}
      {m.summary ? (
        <Text style={{ fontSize: 13.5, color: p.sub, ...lh(21) }}>{m.summary}</Text>
      ) : null}

      <CandleChart
        candles={m.candles}
        lines={lines}
        height={165}
        maxBars={bars}
        colors={{ up: p.up, down: p.down, grid: p.grid, text: p.faint }}
        showPriceAxis={false}
      />

      {/* 어떤 선이 무엇인지 — 보조선 이름 범례 */}
      {(m.overlays ?? []).length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {m.overlays.map((ov, i) => (
            <View
              key={`${ov.name}-${i}`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}
            >
              <View
                style={{
                  width: 12,
                  height: 3,
                  borderRadius: 1.5,
                  backgroundColor: p.ma[i % p.ma.length] ?? p.primary,
                }}
              />
              <Text style={{ fontSize: 12, color: p.faint }}>{ov.name}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <TextButton
        label="이평선 분석 →"
        palette={p}
        onPress={() => onOpenRadar(m)}
        logName={LOG.analyze}
      />
    </Card>
  );
});

function PatternsPage() {
  const p = usePalette();
  const navigation = Route.useNavigation();

  const [pattern, setPattern] = useState<PatternKey>(PATTERNS[0]!.key);
  const [market, setMarket] = useState<Market>('kr');
  const [phase, setPhase] = useState<Phase>('boot');
  // 기다리는 동안 게임에서 새총을 당기는 중이면 스크롤을 잠근다 (안드로이드는 스크롤이 드래그를 빼앗는다)
  const [scrollLock, setScrollLock] = useState(false);
  const [body, setBody] = useState<PatternsResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const { items: watched, toggle: toggleWatch } = useWatchlist();

  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const load = useCallback(async (pk: PatternKey, mk: Market, isPoll: boolean) => {
    const seq = ++seqRef.current;
    clearTimer();
    if (!isPoll) {
      setBody(null);
      setErrorMsg('');
      setPhase('boot');
    }
    try {
      const res = await fetchPatterns(pk, mk);
      if (seq !== seqRef.current) {
        return;
      }
      if (res.status === 'running') {
        setBody(res);
        setPhase('running');
        timerRef.current = setTimeout(() => void load(pk, mk, true), POLL_RUNNING_MS);
        return;
      }
      if (res.status === 'error') {
        setErrorMsg(res.detail || '스캔 실패 — 잠시 후 다시 시도해 주세요.');
        setPhase('error');
        timerRef.current = setTimeout(() => void load(pk, mk, true), RETRY_ERROR_MS);
        return;
      }
      setBody(res);
      setPhase('done');
      if (res.partial || res.refreshing) {
        timerRef.current = setTimeout(() => void load(pk, mk, true), POLL_PARTIAL_MS);
      }
    } catch (err) {
      if (seq !== seqRef.current) {
        return;
      }
      // 레이트리밋은 일시적이다 — 화면을 '실패'로 떨어뜨리지 않고 서버가
      // 알려준 만큼 물러섰다 그대로 다시 폴링한다 (screener 와 동일).
      if (isRateLimited(err)) {
        const waitSec = (err as ApiError).retryAfterSec ?? RATE_LIMIT_BACKOFF_SEC;
        timerRef.current = setTimeout(() => void load(pk, mk, true), waitSec * 1000);
        return;
      }
      // 서버가 아직 이 패턴을 모른다(새 패턴이 서버보다 먼저 나간 경우) — 영어 검증 오류를
      // 보여 주거나 15초마다 헛되이 다시 묻지 않고, 다른 패턴을 고르라고 안내한다
      if (err instanceof ApiError && err.status === 422) {
        setErrorMsg('이 모양은 아직 준비 중이에요. 다른 패턴을 골라 주세요.');
        setPhase('error');
        return;
      }
      setErrorMsg(err instanceof Error ? err.message : '스캔 실패');
      setPhase('error');
      timerRef.current = setTimeout(() => void load(pk, mk, true), RETRY_ERROR_MS);
    }
  }, []);

  useEffect(() => {
    void load(pattern, market, false);
    return () => {
      // 떠난 뒤 도착한 응답이 폴링을 되살리지 않게 시퀀스를 올린다
      seqRef.current++;
      clearTimer();
    };
  }, [pattern, market, load]);

  const openRadar = useCallback(
    (m: PatternMatch) => {
      pendingAnalyze.symbol = m.symbol;
      navigation.navigate('/radar');
    },
    [navigation]
  );

  const current = PATTERNS.find((x) => x.key === pattern) ?? PATTERNS[0]!;

  const statusText = (b: PatternsResponse): string => {
    const shown = (b.matches ?? []).length;
    const total = b.totalMatches ?? 0;
    return (
      `${b.scanned ?? 0}개 종목 ${b.partial ? '스캔 중' : '스캔 완료'} · ${current.label} ${total}개 발견` +
      (total > shown ? ` (상위 ${shown}개 표시)` : '') +
      (b.partial ? ' · 남은 종목 계속 확인 중…' : b.refreshing ? ' · 새 스캔 진행 중' : '')
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <ScrollView
        scrollEnabled={!scrollLock}
        style={{ flex: 1, backgroundColor: p.bg }}
        contentContainerStyle={{
          paddingHorizontal: GUTTER,
          paddingBottom: TAB_BAR_SPACER,
          gap: 12,
        }}
      >
        {/* 홈·관심종목 이동은 하단 탭바가 맡는다 */}
        <PageHeader
          title="차트 패턴"
          subtitle="지금 이 모양을 만들고 있는 종목을 찾아드려요"
          palette={p}
        />

        {/* 패턴 선택 — 생김새끼리 묶어 보여 준다 */}
        <View style={{ gap: 12 }}>
          {GROUPS.map((g) => (
            <View key={g.title} style={{ gap: 6 }}>
              <Text accessibilityRole="header" style={{ fontSize: 12.5, fontWeight: '600', color: p.faint }}>
                {g.title}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {g.keys.map((k) => {
                  const x = PATTERNS.find((y) => y.key === k);
                  return x ? (
                    <Chip
                      key={x.key}
                      label={x.label}
                      active={pattern === x.key}
                      palette={p}
                      onPress={() => setPattern(x.key)}
                    />
                  ) : null;
                })}
              </View>
            </View>
          ))}
        </View>

        {/* 고른 패턴이 뭔지 한 줄로 — 초보가 이름만 보고 멈추지 않게 */}
        <Card palette={p} style={{ gap: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <IconChip glyph={current.emoji} accent="violet" palette={p} size={36} />
            <Text style={{ fontSize: 17, fontWeight: '700', color: p.text }}>{current.label}</Text>
          </View>
          <Text style={{ fontSize: 14.5, color: p.sub, ...lh(23) }}>{current.plain}</Text>
          <Expandable title="좀 더 자세히" palette={p} surface={p.sunken}>
            <Text style={{ fontSize: 13.5, color: p.sub, ...lh(21) }}>{current.detail}</Text>
          </Expandable>
          {/* 패턴을 매수신호로 읽지 않게 — 설명과 같은 카드 안에 둔다 */}
          <Notice palette={p}>
            패턴은 &apos;지금 이런 모양&apos;이라는 관찰일 뿐이에요. 모양이 나왔다고 그대로
            간다는 보장은 없고, 매수·매도 신호가 아닙니다.
          </Notice>
        </Card>

        {/* 시장 선택 */}
        <Segmented
          options={MARKET_OPTIONS}
          value={market}
          palette={p}
          onChange={(v) => setMarket(v)}
        />

        {phase === 'boot' ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }}>
            <ActivityIndicator color={p.primary} />
            <Text style={{ fontSize: 14, color: p.sub }}>패턴 스캔 확인 중…</Text>
          </View>
        ) : null}

        {phase === 'running' && body ? (
          // 스캔은 1~2분 걸린다 — 진행 막대만 보고 기다리기엔 길어서, 춤추는 캐릭터와
          // 짧은 글을 함께 보여 준다 (components/WaitingShow)
          <WaitingShow
            palette={p}
            title={`${market === 'kr' ? '국내' : '미국'} 종목 패턴 스캔 중 · ${
              body.total ? `${body.done ?? 0}/${body.total} 종목` : '대상 선정 중'
            }`}
            subtitle="보통 1~2분"
            progress={body.total ? (body.done ?? 0) / body.total : 0}
            onInteract={setScrollLock}
          />
        ) : null}

        {phase === 'error' ? (
          <Card palette={p} style={{ gap: 14 }}>
            <Text style={{ fontSize: 14, color: p.danger }}>스캔 실패: {errorMsg}</Text>
            <PrimaryButton
              label="다시 시도"
              palette={p}
              onPress={() => void load(pattern, market, false)}
            />
          </Card>
        ) : null}

        {phase === 'done' && body ? (
          <>
            <View
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <Text style={{ fontSize: 12, color: p.faint, flexShrink: 1, ...lh(18) }}>
                {statusText(body)}
              </Text>
              {!body.partial && !body.refreshing ? (
                <TextButton
                  label="새로고침"
                  size={13}
                  palette={p}
                  onPress={() => void load(pattern, market, false)}
                />
              ) : null}
            </View>
            {(body.matches ?? []).length === 0 ? (
              <Card palette={p}>
                <Text style={{ fontSize: 14, color: p.sub, ...lh(22) }}>
                  {body.partial
                    ? '남은 종목을 확인하는 중입니다…\n이 모양을 만드는 종목이 나오면 여기 채워집니다.'
                    : `지금 ${current.label} 모양을 만들고 있는 종목이 없습니다.\n패턴은 매일 달라집니다 — 다른 패턴이나 다른 시장을 살펴보세요.`}
                </Text>
              </Card>
            ) : null}
            {(body.matches ?? []).map((m) => (
              <PatternCard
                key={`${m.symbol}-${pattern}`}
                match={m}
                palette={p}
                bars={current.bars ?? CHART_BARS}
                watched={isWatched(watched, m.symbol)}
                onToggleWatch={toggleWatch}
                onOpenRadar={openRadar}
              />
            ))}
          </>
        ) : null}

        <Footer palette={p} />
      </ScrollView>
      <TabBar current="/patterns" palette={p} onNavigate={(to) => navigation.navigate(to)} />
    </View>
  );
}
