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
import { groupOf, patternInfo, toGroupKey } from '../patternCatalog';

export const Route = createRoute('/pattern-group', {
  validateParams: (params) => ({ group: toGroupKey((params as { group?: unknown } | undefined)?.group) }),
  component: PatternGroupPage,
});

// unsupported: 서버가 아직 모르는 패턴(422) — 실패도 아니고 다시 해도 같으니 버튼 없이 안내만
type Phase = 'boot' | 'running' | 'done' | 'error' | 'unsupported';

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

// 다른 묶음으로 옮겨 가도 고른 시장(국내·미국)은 그대로 — 화면을 새로 열 때마다 국내로 돌아가지 않게
let lastMarket: Market = 'kr';

function PatternGroupPage() {
  const p = usePalette();
  const navigation = Route.useNavigation();
  const { group: groupKey } = Route.useParams();
  const group = groupOf(groupKey);

  const [pattern, setPattern] = useState<PatternKey>(group.keys[0]!);
  const [market, setMarketState] = useState<Market>(lastMarket);
  const setMarket = (m: Market) => {
    lastMarket = m;
    setMarketState(m);
  };
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
        setPhase('unsupported');
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

  const current = patternInfo(pattern);

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
        {/* 뒤로 가기는 토스 상단바가, 다른 탭 이동은 하단 탭바가 맡는다 */}
        <PageHeader title={group.title} subtitle={group.desc} palette={p} />

        {/* 이 묶음의 패턴만 */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {group.keys.map((k) => (
            <Chip
              key={k}
              label={patternInfo(k).label}
              active={pattern === k}
              palette={p}
              onPress={() => setPattern(k)}
            />
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

        {phase === 'unsupported' ? (
          <Card palette={p}>
            <Text style={{ fontSize: 14, color: p.sub, ...lh(22) }}>
              이 모양은 아직 준비 중이에요. 다른 패턴을 골라 주세요.
            </Text>
          </Card>
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
