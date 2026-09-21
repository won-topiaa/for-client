import { createRoute } from '@granite-js/react-native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { ApiError, fetchTouches, isRateLimited } from '../api/client';
import type { Market, TouchesResponse, TouchMatch } from '../api/types';
import { CandleChart } from '../components/CandleChart';
import { TabBar, TAB_BAR_SPACER } from '../components/TabBar';
import { Card, Chip, Expandable, Footer, PrimaryButton, StarButton } from '../components/ui';
import { SCREENER_RULE_LABEL } from '../env';
import { fmtDistPct, fmtPrice, fmtRate } from '../format';
import { pendingAnalyze } from '../store';
import { usePalette } from '../theme';
import { isWatched, useWatchlist } from '../watchlist';

export const Route = createRoute('/screener', {
  component: ScreenerPage,
});

type Phase = 'boot' | 'running' | 'done' | 'error';

const POLL_RUNNING_MS = 2000; // 스캔 진행 중 폴링 간격 (웹과 동일)
const POLL_PARTIAL_MS = 5000; // 부분 결과가 채워지는 동안
const RETRY_ERROR_MS = 15000;
// 429 를 맞았을 때 서버가 Retry-After 를 안 줬다면 쓰는 기본 대기 (서버 창은 60초)
const RATE_LIMIT_BACKOFF_SEC = 30;

/**
 * 매치 한 건 카드. React.memo 로 감싼 이유:
 *
 * 관심종목 목록이 바뀌면(별 한 번 누르면) 배열 정체성이 바뀌어 페이지 전체가
 * 다시 그려진다. 카드마다 캔들차트가 들어 있고 차트는 봉 하나당 View 2개를
 * 절대배치로 그리므로, 최대 12장 × 40봉이면 별 한 번에 수천 개 View 가 다시
 * 배치된다. 카드를 분리하고 watched 를 불리언으로 받으면, 실제로 상태가 바뀐
 * 카드 하나만 다시 그린다. (차트에 넘기는 배열·객체는 이 안에서 만들어지므로
 * 카드가 리렌더되지 않는 한 새로 생기지도 않는다.)
 */
const MatchCard = React.memo(function MatchCard({
  match: m,
  palette: p,
  watched,
  onToggleWatch,
  onOpenRadar,
}: {
  match: TouchMatch;
  palette: ReturnType<typeof usePalette>;
  watched: boolean;
  onToggleWatch: (item: { symbol: string; name: string; market?: string | null }) => void;
  onOpenRadar: (m: TouchMatch) => void;
}) {
  // Number.isFinite 검사: 값이 없으면 Math.round 가 NaN 이 되고 style.width 가
  // "NaN%" 라는 잘못된 값이 돼 막대가 사라진다 (서버 필드명이 바뀌면 실제로 그랬다).
  const ratePct = Number.isFinite(m.supportRate)
    ? Math.max(0, Math.min(100, Math.round(m.supportRate * 100)))
    : 0;
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
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View
            style={{
              backgroundColor: p.emeraldBg,
              borderRadius: 6,
              paddingVertical: 3,
              paddingHorizontal: 8,
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: '700', color: p.up }}>MA {m.period}</Text>
          </View>
          <StarButton
            watched={watched}
            palette={p}
            label={m.name}
            onPress={() => onToggleWatch({ symbol: m.symbol, name: m.name, market: m.market })}
          />
        </View>
      </View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: p.border, overflow: 'hidden' }}>
        <View style={{ height: 6, width: `${ratePct}%`, backgroundColor: p.up }} />
      </View>
      {/* 가격 한 줄 — 숫자를 이름표와 함께 세워 둔다.
          예전에는 '선 대비 +1.2%' 만 있고 지금 얼마인지가 없어서, 보는 사람이
          비율만으로 감을 잡아야 했다(토론에서 중급자가 지적한 부분). */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        <View>
          <Text style={{ fontSize: 10, color: p.faint }}>현재가</Text>
          <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
            {fmtPrice(m.close)}
          </Text>
        </View>
        <View>
          <Text style={{ fontSize: 10, color: p.faint }}>MA {m.period} 선</Text>
          <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
            {fmtPrice(m.maValue)}
          </Text>
        </View>
        <View>
          <Text style={{ fontSize: 10, color: p.faint }}>선 대비</Text>
          <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
            {fmtDistPct(m.distPct)}
          </Text>
        </View>
      </View>
      <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19 }}>
        {/* 분모는 supportTests(지지 판정 시도) — touches 는 저항 터치까지 포함해서
            함께 쓰면 성공률과 계산이 안 맞는다(34/89=38% vs 표기 77%).
            이름은 '지지 성공률' 하나로 통일한다 — 예전엔 같은 수치를 여기서만
            '최근 가중 성공률'이라 불러서 다른 지표처럼 보였다. */}
        3년 지지 시험 {m.supportTests}회 중{' '}
        <Text style={{ fontWeight: '700', color: p.text }}>{m.supportBounces}회 성공</Text>
        {' · '}지지 성공률{' '}
        <Text style={{ fontWeight: '700', color: p.text }}>{fmtRate(m.supportRate)}</Text>
      </Text>
      <CandleChart
        candles={m.candles}
        lines={[{ color: p.amber, points: m.maLine, width: 2 }]}
        markers={
          m.candles.length > 0
            ? [
                {
                  time: m.candles[m.candles.length - 1]?.time ?? '',
                  shape: 'arrowUp',
                  color: p.indigo,
                  position: 'below',
                },
              ]
            : []
        }
        height={140}
        maxBars={40}
        colors={{ up: p.up, down: p.down, grid: p.grid, text: p.faint }}
        showPriceAxis={false}
      />
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

function ScreenerPage() {
  const p = usePalette();
  const navigation = Route.useNavigation();

  const [market, setMarket] = useState<Market>('kr');
  const [phase, setPhase] = useState<Phase>('boot');
  const [body, setBody] = useState<TouchesResponse | null>(null);
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

  const load = useCallback(
    async (mk: Market, isPoll: boolean) => {
      const seq = ++seqRef.current;
      clearTimer();
      if (!isPoll) {
        setBody(null);
        setErrorMsg('');
        setPhase('boot');
      }
      try {
        const res = await fetchTouches(mk);
        if (seq !== seqRef.current) {
          return;
        }
        if (res.status === 'running') {
          setBody(res);
          setPhase('running');
          timerRef.current = setTimeout(() => void load(mk, true), POLL_RUNNING_MS);
          return;
        }
        if (res.status === 'error') {
          setErrorMsg(res.detail || '스캔 실패 — 잠시 후 다시 시도해 주세요.');
          setPhase('error');
          timerRef.current = setTimeout(() => void load(mk, true), RETRY_ERROR_MS);
          return;
        }
        setBody(res);
        setPhase('done');
        // 부분/재스캔 중이면 계속 채워지므로 이어서 폴링, 완성 결과면 멈춘다
        if (res.partial || res.refreshing) {
          timerRef.current = setTimeout(() => void load(mk, true), POLL_PARTIAL_MS);
        }
      } catch (err) {
        if (seq !== seqRef.current) {
          return;
        }
        // 레이트리밋은 일시적이다 — 화면을 '스캔 실패'로 떨어뜨리거나 이미 받아
        // 둔 결과를 지우지 않고, 서버가 알려준 만큼 물러섰다 그대로 다시 폴링한다.
        // (RETRY_ERROR_MS 로 성급히 재시도하면 아직 안 풀린 창에 또 걸린다.)
        if (isRateLimited(err)) {
          const waitSec = (err as ApiError).retryAfterSec ?? RATE_LIMIT_BACKOFF_SEC;
          timerRef.current = setTimeout(() => void load(mk, true), waitSec * 1000);
          return;
        }
        setErrorMsg(err instanceof Error ? err.message : '스캔 실패');
        setPhase('error');
        timerRef.current = setTimeout(() => void load(mk, true), RETRY_ERROR_MS);
      }
    },
    []
  );

  useEffect(() => {
    void load(market, false);
    return () => {
      // 진행 중이던 응답이 화면을 떠난 뒤 도착해 타이머를 다시 걸지 않도록
      // 시퀀스를 올려 무효화한다 (타이머만 지우면 폴링이 몰래 계속된다)
      seqRef.current++;
      clearTimer();
    };
  }, [market, load]);

  const statusText = (b: TouchesResponse): string => {
    const shown = (b.matches ?? []).length;
    const total = b.totalMatches ?? 0;
    return (
      `${b.scanned}개 종목 ${b.partial ? '백테스트' : '백테스트 완료'} · 오늘 지지선 터치 ${total}개` +
      (total > shown ? ` (상위 ${shown}개 표시)` : '') +
      (b.partial ? ' · 남은 종목 계속 확인 중…' : b.refreshing ? ' · 백그라운드에서 새 스캔 진행 중' : '')
    );
  };

  // useCallback: MatchCard 가 React.memo 라 콜백이 매 렌더 새로 생기면
  // 메모가 무의미해진다 (카드 12장이 전부 다시 그려진다).
  const openRadar = useCallback(
    (m: TouchMatch) => {
      pendingAnalyze.symbol = m.symbol;
      navigation.navigate('/radar');
    },
    [navigation]
  );

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
    <ScrollView
      style={{ flex: 1, backgroundColor: p.bg }}
      contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: TAB_BAR_SPACER }}
    >
      {/* 홈·관심종목 이동은 하단 탭바가 맡는다 */}
      <View style={{ flexShrink: 1 }}>
        <Text style={{ fontSize: 22, fontWeight: '800', color: p.text }}>오늘의 지지선</Text>
        <Text style={{ fontSize: 12, color: p.sub, marginTop: 2 }}>
          검증된 지지 이평선에 오늘 저가가 닿은 종목만
        </Text>
      </View>

      <View style={{ flexDirection: 'row', gap: 6 }}>
        <Chip label="🇰🇷 국내" active={market === 'kr'} palette={p} onPress={() => setMarket('kr')} />
        <Chip label="🇺🇸 미국" active={market === 'us'} palette={p} onPress={() => setMarket('us')} />
      </View>

      {/* '닿음'을 매수 신호로 읽지 않게 — 카드마다 반복하면 잔소리가 되므로
          목록 위에 한 번만 둔다 */}
      <Text style={{ fontSize: 11, color: p.amber, lineHeight: 17 }}>
        지지선에 닿았다는 건 &apos;지켜보기 좋은 지점&apos;이라는 뜻이에요. 성공률은 과거
        통계일 뿐, 매수 신호가 아닙니다.
      </Text>

      <Expandable title="스캔 기준 · 지지 성공률이란?" palette={p}>
        <Text style={{ fontSize: 11, color: p.faint, lineHeight: 16 }}>
          {SCREENER_RULE_LABEL} 인정합니다. 5일선은 제외 — 단기선은 지지 신뢰도가 낮습니다.
        </Text>
        {/* 같은 수치를 화면마다 다른 이름으로 부르지 않는다. 뜻은 여기 한 번만 적는다. */}
        <Text style={{ fontSize: 11, color: p.faint, lineHeight: 16, marginTop: 6 }}>
          지지 성공률 = 그 선까지 눌렸을 때 실제로 버틴 비율입니다. 오래된 일보다
          최근 일에 더 큰 가중치를 줘서, 요즘 잘 지켜지는 선이 높게 나옵니다.
        </Text>
      </Expandable>

      {phase === 'boot' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }}>
          <ActivityIndicator color={p.up} />
          <Text style={{ fontSize: 13, color: p.sub }}>지지선 터치 스캔 확인 중…</Text>
        </View>
      ) : null}

      {phase === 'running' && body ? (
        <Card palette={p} style={{ gap: 8 }}>
          <Text style={{ fontSize: 13, color: p.sub }}>
            {market === 'kr' ? '국내' : '미국'} 종목 백테스트 중…{' '}
            {body.total ? `${body.done ?? 0}/${body.total} 종목` : '대상 선정 중'}
          </Text>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: p.border, overflow: 'hidden' }}>
            <View
              style={{
                height: 8,
                width: `${body.total ? Math.round(((body.done ?? 0) / body.total) * 100) : 0}%`,
                backgroundColor: p.up,
              }}
            />
          </View>
          <Text style={{ fontSize: 11, color: p.faint }}>
            서버가 종목마다 3년 백테스트를 돌리는 중이에요 — 보통 1~2분이면 끝나요.
          </Text>
        </Card>
      ) : null}

      {phase === 'error' ? (
        <Card palette={p} style={{ gap: 10 }}>
          <Text style={{ fontSize: 13, color: p.down }}>스캔 실패: {errorMsg}</Text>
          <PrimaryButton label="다시 시도" palette={p} onPress={() => void load(market, false)} />
        </Card>
      ) : null}

      {phase === 'done' && body ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 11, color: p.faint, flexShrink: 1 }}>{statusText(body)}</Text>
            {!body.partial && !body.refreshing ? (
              <TouchableOpacity
                onPress={() => void load(market, false)}
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
                  ? '남은 종목을 확인하는 중입니다…\n오늘 지지선에 닿은 종목이 나오면 여기 채워집니다.'
                  : '오늘 검증된 지지선에 닿아 있는 종목이 없습니다.\n터치는 매일 달라집니다 — 내일 다시 확인하거나 다른 시장을 살펴보세요.'}
              </Text>
            </Card>
          ) : null}
          {(body.matches ?? []).map((m) => (
            <MatchCard
              key={`${m.symbol}-${m.period}`}
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
    <TabBar current="/screener" palette={p} onNavigate={(to) => navigation.navigate(to)} />
    </View>
  );
}
