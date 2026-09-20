import { createRoute } from '@granite-js/react-native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { ApiError, fetchPatterns, isRateLimited } from '../api/client';
import type { Market, PatternKey, PatternMatch, PatternsResponse } from '../api/types';
import { CandleChart, type ChartLine } from '../components/CandleChart';
import { TabBar, TAB_BAR_SPACER } from '../components/TabBar';
import { Card, Chip, Expandable, Footer, PrimaryButton, StarButton } from '../components/ui';
import { pendingAnalyze } from '../store';
import { usePalette } from '../theme';
import { isWatched, useWatchlist } from '../watchlist';

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

/**
 * 화면에 노출하는 패턴. 서버는 5종(헤드앤숄더·역헤드앤숄더 포함)을 주지만,
 * 여기서는 초보도 한 줄로 이해할 수 있는 셋만 먼저 보여준다.
 * 늘리고 싶으면 이 배열에 추가만 하면 된다 (서버·타입 수정 불필요).
 */
const PATTERNS: {
  key: PatternKey;
  label: string;
  emoji: string;
  plain: string;
  detail: string;
}[] = [
  {
    key: 'stage2',
    label: '초기 상승추세',
    emoji: '📈',
    plain: '바닥에서 오래 눌려 있다가, 이제 막 위로 방향을 튼 모양이에요.',
    detail:
      '긴 횡보(바닥 다지기)를 끝내고 주가가 장기 이동평균선 위로 올라서면서 ' +
      '상승 추세의 초입에 들어선 상태를 찾습니다. 이미 많이 오른 종목이 아니라 ' +
      '"막 출발한" 구간을 골라내는 것이 목적이에요.',
  },
  {
    key: 'triangle',
    label: '삼각수렴',
    emoji: '📐',
    plain: '고점은 낮아지고 저점은 높아지며 변동폭이 점점 좁아지는 모양이에요.',
    detail:
      '위아래로 흔들리던 폭이 점점 줄어 한 점으로 모이는 구간입니다. 눌린 ' +
      '스프링처럼 에너지가 응축돼, 좁아진 끝에서 한쪽으로 크게 움직이는 경향이 ' +
      '있어요. 다만 어느 쪽으로 터질지는 패턴만으로 정해지지 않습니다.',
  },
  {
    key: 'cup_handle',
    label: '컵앤핸들',
    emoji: '☕',
    plain: 'U자로 완만히 회복한 뒤, 살짝 눌러 쉬어가는 모양이에요.',
    detail:
      '깊게 빠졌다가 둥근 U자를 그리며 이전 고점 근처까지 돌아온 뒤(컵), ' +
      '짧고 얕게 조정받는 구간(핸들)이 붙은 형태입니다. 손잡이 구간에서 ' +
      '매물이 정리되는 것으로 보는 고전적인 상승 지속형 패턴이에요.',
  },
];

/**
 * 매치 한 건. React.memo 인 이유는 screener 와 같다 — 관심종목이 바뀌면
 * 배열 정체성이 바뀌어 페이지가 다시 그려지는데, 카드마다 200봉 캔들차트가
 * 들어 있어 별 한 번에 수천 개 View 가 다시 배치된다.
 */
const PatternCard = React.memo(function PatternCard({
  match: m,
  palette: p,
  watched,
  onToggleWatch,
  onOpenRadar,
}: {
  match: PatternMatch;
  palette: ReturnType<typeof usePalette>;
  watched: boolean;
  onToggleWatch: (item: { symbol: string; name: string; market?: string | null }) => void;
  onOpenRadar: (m: PatternMatch) => void;
}) {
  // 보조선은 이평선과 같은 형태({time,value})라 차트의 lines 로 그대로 넘긴다.
  const lines: ChartLine[] = (m.overlays ?? []).map((ov, i) => ({
    color: p.ma[i % p.ma.length] ?? p.indigo,
    points: ov.points,
    width: 2,
  }));

  return (
    <Card palette={p} style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ fontSize: 15, color: p.text, flexShrink: 1 }} numberOfLines={1}>
          <Text style={{ fontWeight: '800' }}>{m.name}</Text>
          <Text style={{ fontSize: 12, color: p.faint }}>
            {'  '}
            {m.symbol}
            {m.market ? ` · ${m.market}` : ''}
          </Text>
        </Text>
        <StarButton
          watched={watched}
          palette={p}
          label={m.name}
          onPress={() => onToggleWatch({ symbol: m.symbol, name: m.name, market: m.market })}
        />
      </View>

      {/* 왜 이 패턴으로 봤는지 — 서버가 만든 한 줄 */}
      {m.summary ? (
        <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19 }}>{m.summary}</Text>
      ) : null}

      <CandleChart
        candles={m.candles}
        lines={lines}
        height={165}
        maxBars={CHART_BARS}
        colors={{ up: p.up, down: p.down, grid: p.grid, text: p.faint }}
        showPriceAxis={false}
      />

      {/* 어떤 선이 무엇인지 — 보조선 이름 범례 */}
      {(m.overlays ?? []).length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {m.overlays.map((ov, i) => (
            <View key={`${ov.name}-${i}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <View
                style={{
                  width: 10,
                  height: 3,
                  borderRadius: 1.5,
                  backgroundColor: p.ma[i % p.ma.length] ?? p.indigo,
                }}
              />
              <Text style={{ fontSize: 10, color: p.faint }}>{ov.name}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <TouchableOpacity
        onPress={() => onOpenRadar(m)}
        accessibilityRole="button"
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Text style={{ fontSize: 13, color: p.indigo, fontWeight: '600' }}>이평선 분석 →</Text>
      </TouchableOpacity>
    </Card>
  );
});

function PatternsPage() {
  const p = usePalette();
  const navigation = Route.useNavigation();

  const [pattern, setPattern] = useState<PatternKey>('stage2');
  const [market, setMarket] = useState<Market>('kr');
  const [phase, setPhase] = useState<Phase>('boot');
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
      style={{ flex: 1, backgroundColor: p.bg }}
      contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: TAB_BAR_SPACER }}
    >
      {/* 홈·관심종목 이동은 하단 탭바가 맡는다 */}
      <View style={{ flexShrink: 1 }}>
        <Text style={{ fontSize: 22, fontWeight: '800', color: p.text }}>차트 패턴</Text>
        <Text style={{ fontSize: 12, color: p.sub, marginTop: 2 }}>
          지금 이 모양을 만들고 있는 종목을 찾아드려요
        </Text>
      </View>

      {/* 패턴 선택 */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {PATTERNS.map((x) => (
          <Chip
            key={x.key}
            label={`${x.emoji} ${x.label}`}
            active={pattern === x.key}
            palette={p}
            onPress={() => setPattern(x.key)}
          />
        ))}
      </View>

      {/* 고른 패턴이 뭔지 한 줄로 — 초보가 이름만 보고 멈추지 않게 */}
      <Card palette={p} style={{ gap: 8 }}>
        <Text style={{ fontSize: 14, fontWeight: '700', color: p.text }}>
          {current.emoji} {current.label}
        </Text>
        <Text style={{ fontSize: 12.5, color: p.sub, lineHeight: 20 }}>{current.plain}</Text>
        <Expandable title="좀 더 자세히" palette={p}>
          <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19 }}>{current.detail}</Text>
        </Expandable>
        {/* 패턴을 매수신호로 읽지 않게 — 성공률 표기와 같은 자리에 둔다 */}
        <Text style={{ fontSize: 11, color: p.amber, lineHeight: 17 }}>
          패턴은 &apos;지금 이런 모양&apos;이라는 관찰일 뿐이에요. 모양이 나왔다고 그대로
          간다는 보장은 없고, 매수 신호가 아닙니다.
        </Text>
      </Card>

      {/* 시장 선택 */}
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <Chip label="🇰🇷 국내" active={market === 'kr'} palette={p} onPress={() => setMarket('kr')} />
        <Chip label="🇺🇸 미국" active={market === 'us'} palette={p} onPress={() => setMarket('us')} />
      </View>

      {phase === 'boot' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }}>
          <ActivityIndicator color={p.indigo} />
          <Text style={{ fontSize: 13, color: p.sub }}>패턴 스캔 확인 중…</Text>
        </View>
      ) : null}

      {phase === 'running' && body ? (
        <Card palette={p} style={{ gap: 8 }}>
          <Text style={{ fontSize: 13, color: p.sub }}>
            {market === 'kr' ? '국내' : '미국'} 종목 패턴 스캔 중…{' '}
            {body.total ? `${body.done ?? 0}/${body.total} 종목` : '대상 선정 중'}
          </Text>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: p.border, overflow: 'hidden' }}>
            <View
              style={{
                height: 8,
                width: `${body.total ? Math.round(((body.done ?? 0) / body.total) * 100) : 0}%`,
                backgroundColor: p.indigo,
              }}
            />
          </View>
          <Text style={{ fontSize: 11, color: p.faint }}>
            서버가 종목마다 패턴 모양을 맞춰보는 중이에요 — 보통 1~2분이면 끝나요.
          </Text>
        </Card>
      ) : null}

      {phase === 'error' ? (
        <Card palette={p} style={{ gap: 10 }}>
          <Text style={{ fontSize: 13, color: p.down }}>스캔 실패: {errorMsg}</Text>
          <PrimaryButton
            label="다시 시도"
            palette={p}
            onPress={() => void load(pattern, market, false)}
          />
        </Card>
      ) : null}

      {phase === 'done' && body ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 11, color: p.faint, flexShrink: 1 }}>{statusText(body)}</Text>
            {!body.partial && !body.refreshing ? (
              <TouchableOpacity
                onPress={() => void load(pattern, market, false)}
                accessibilityRole="button"
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Text style={{ fontSize: 12, color: p.indigo, fontWeight: '600' }}>새로고침</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {(body.matches ?? []).length === 0 ? (
            <Card palette={p}>
              <Text style={{ fontSize: 13, color: p.sub, lineHeight: 19 }}>
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
