import { createRoute } from '@granite-js/react-native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { ApiError, fetchLines, isRateLimited } from '../api/client';
import type { LineMatch, LineSide, LinesResponse, Market } from '../api/types';
import { LOG } from '../analytics';
import { CandleChart } from '../components/CandleChart';
import { TabBar, TAB_BAR_SPACER } from '../components/TabBar';
import {
  Badge,
  Card,
  Chip,
  Expandable,
  Footer,
  Notice,
  PageHeader,
  PrimaryButton,
  Segmented,
  StarButton,
  TextButton,
} from '../components/ui';
import { fmtDistPct, fmtPrice, fmtRate } from '../format';
import { pendingAnalyze } from '../store';
import { GUTTER, signColor, usePalette, type Palette } from '../theme';
import { isWatched, useWatchlist } from '../watchlist';

export const Route = createRoute('/lines', {
  component: LinesPage,
});

type Phase = 'boot' | 'running' | 'done' | 'error';

const POLL_RUNNING_MS = 2000;
const POLL_PARTIAL_MS = 5000;
const RETRY_ERROR_MS = 15000;
const RATE_LIMIT_BACKOFF_SEC = 30;

// 고를 수 있는 기간을 대표값으로 묶어 둔 이유(자유 입력이 아닌 이유):
// 서버는 (시장, 기간) 조합마다 스캐너를 하나씩 두고 결과를 하루 고정한다.
// 숫자를 흩뿌리면 조합이 늘어 슬롯 상한(16)에 부딪히고, 그때부터는 재계산
// 대신 429 가 돌아온다. 웹 화면의 프리셋과 같은 값이라 캐시도 함께 탄다.
// (폰에서 '몇 일선?'에 숫자 키패드를 띄우는 것도 좋은 입력이 아니다)
const PERIODS = [20, 50, 60, 120, 200] as const;

const MARKET_OPTIONS: { value: Market; label: string }[] = [
  { value: 'kr', label: '국내' },
  { value: 'us', label: '미국' },
];

const SIDE_OPTIONS: { value: LineSide; label: string }[] = [
  { value: 'support', label: '지지 받는 중' },
  { value: 'resistance', label: '저항에 막힘' },
];

const SIDE_WORD: Record<LineSide, string> = { support: '지지', resistance: '저항' };

/** 이름표 위, 숫자 아래 — 지지선 화면과 같은 두 줄 묶음. */
function Stat({
  label,
  value,
  palette: p,
  color,
}: {
  label: string;
  value: string;
  palette: Palette;
  color?: string;
}) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={{ fontSize: 12, color: p.faint }}>{label}</Text>
      <Text
        style={{ fontSize: 15, fontWeight: '700', color: color ?? p.text, marginTop: 2 }}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

/**
 * 매치 한 건. React.memo 인 이유는 screener·patterns 와 같다 — 관심종목이
 * 바뀌면 배열 정체성이 바뀌어 페이지가 다시 그려지는데, 카드마다 캔들차트가
 * 들어 있어 별 한 번에 수천 개 View 가 다시 배치된다.
 */
const LineCard = React.memo(function LineCard({
  match: m,
  palette: p,
  watched,
  onToggleWatch,
  onOpenRadar,
}: {
  match: LineMatch;
  palette: Palette;
  watched: boolean;
  onToggleWatch: (item: { symbol: string; name: string; market?: string | null }) => void;
  onOpenRadar: (m: LineMatch) => void;
}) {
  // Number.isFinite 검사: 값이 없으면 Math.round 가 NaN 이 되고 style.width 가
  // "NaN%" 라는 잘못된 값이 돼 막대가 사라진다 (지지선 화면에서 실제로 그랬다).
  const ratePct = Number.isFinite(m.respectRate)
    ? Math.max(0, Math.min(100, Math.round(m.respectRate * 100)))
    : 0;
  const word = SIDE_WORD[m.side] ?? '지지';
  return (
    <Card palette={p} style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flexShrink: 1, paddingRight: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text
              style={{ fontSize: 17, fontWeight: '700', color: p.text, flexShrink: 1 }}
              numberOfLines={1}
            >
              {m.name}
            </Text>
            <Badge label={`MA ${m.period}`} palette={p} tone="primary" />
          </View>
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

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Stat label="현재가" value={fmtPrice(m.close)} palette={p} />
        <Stat label={`MA ${m.period} 선`} value={fmtPrice(m.maValue)} palette={p} />
        <Stat
          label="선 대비"
          value={fmtDistPct(m.distPct)}
          palette={p}
          color={signColor(m.distPct, p)}
        />
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 13.5, color: p.sub, lineHeight: 21 }}>
          {/* 분모는 decided(그 방향에서 결판난 횟수). touches 는 양방향 터치
              총합이라 여기 세워 두면 계산이 안 맞는 것처럼 보인다 — 지지선
              화면에서 똑같은 이유로 한 번 고쳤다.
              성공률은 최근에 가중치를 준 값이라 decided × rate 가 정수로
              떨어지지 않는다. 없는 '성공 횟수'를 지어내지 않고 둘만 적는다. */}
          3년 {word} 판정 {m.decided}회 · {word} 성공률{' '}
          <Text style={{ fontWeight: '700', color: p.text }}>{fmtRate(m.respectRate)}</Text>
        </Text>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: p.sunken, overflow: 'hidden' }}>
          <View style={{ height: 6, width: `${ratePct}%`, backgroundColor: p.primary }} />
        </View>
        <Text style={{ fontSize: 12, color: p.faint }}>
          선 기울기 {fmtDistPct(m.slopePct)} (10봉)
        </Text>
      </View>

      <CandleChart
        candles={m.candles}
        lines={[{ color: p.ma[0] ?? p.primary, points: m.maLine, width: 2 }]}
        height={140}
        maxBars={40}
        colors={{ up: p.up, down: p.down, grid: p.grid, text: p.faint }}
        showPriceAxis={false}
      />
      <TextButton
        label="이평선 분석 →"
        palette={p}
        onPress={() => onOpenRadar(m)}
        logName={LOG.analyze}
      />
    </Card>
  );
});

function LinesPage() {
  const p = usePalette();
  const navigation = Route.useNavigation();

  const [market, setMarket] = useState<Market>('kr');
  const [period, setPeriod] = useState<number>(20);
  const [side, setSide] = useState<LineSide>('support');
  const [phase, setPhase] = useState<Phase>('boot');
  const [body, setBody] = useState<LinesResponse | null>(null);
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

  const load = useCallback(async (mk: Market, pd: number, isPoll: boolean) => {
    const seq = ++seqRef.current;
    clearTimer();
    if (!isPoll) {
      setBody(null);
      setErrorMsg('');
      setPhase('boot');
    }
    try {
      const res = await fetchLines(mk, pd);
      if (seq !== seqRef.current) {
        return;
      }
      if (res.status === 'running') {
        setBody(res);
        setPhase('running');
        timerRef.current = setTimeout(() => void load(mk, pd, true), POLL_RUNNING_MS);
        return;
      }
      if (res.status === 'error') {
        setErrorMsg(res.detail || '스캔 실패 — 잠시 후 다시 시도해 주세요.');
        setPhase('error');
        timerRef.current = setTimeout(() => void load(mk, pd, true), RETRY_ERROR_MS);
        return;
      }
      if (res.unchanged) {
        // 서버가 '직전과 같다'고만 답한 경우 — 목록이 실려 있지 않다.
        // 그대로 setBody 하면 보고 있던 카드가 사라지고 '종목이 없습니다'가 된다.
        // (지금은 since 를 보내지 않아 올 일이 없지만, 보내게 되는 순간 터진다)
        setPhase('done');
        return;
      }
      setBody(res);
      setPhase('done');
      if (res.partial || res.refreshing) {
        timerRef.current = setTimeout(() => void load(mk, pd, true), POLL_PARTIAL_MS);
      }
    } catch (err) {
      if (seq !== seqRef.current) {
        return;
      }
      // 레이트리밋은 일시적이다 — 화면을 '실패'로 떨어뜨리지 않고 서버가
      // 알려준 만큼 물러섰다 그대로 다시 폴링한다 (screener 와 동일).
      // 이 화면은 특히 429 를 만날 여지가 있다: 기간을 여러 번 바꾸면 서버
      // 스캐너 슬롯이 차서 되밀린다.
      if (isRateLimited(err)) {
        const waitSec = (err as ApiError).retryAfterSec ?? RATE_LIMIT_BACKOFF_SEC;
        timerRef.current = setTimeout(() => void load(mk, pd, true), waitSec * 1000);
        return;
      }
      setErrorMsg(err instanceof Error ? err.message : '스캔 실패');
      setPhase('error');
      timerRef.current = setTimeout(() => void load(mk, pd, true), RETRY_ERROR_MS);
    }
  }, []);

  useEffect(() => {
    void load(market, period, false);
    return () => {
      // 떠난 뒤 도착한 응답이 폴링을 되살리지 않게 시퀀스를 올린다
      seqRef.current++;
      clearTimer();
    };
  }, [market, period, load]);

  const openRadar = useCallback(
    (m: LineMatch) => {
      pendingAnalyze.symbol = m.symbol;
      navigation.navigate('/radar');
    },
    [navigation]
  );

  const list = (side === 'support' ? body?.support : body?.resistance) ?? [];
  const total = (side === 'support' ? body?.totalSupport : body?.totalResistance) ?? 0;
  const word = SIDE_WORD[side];

  const statusText = (b: LinesResponse): string => {
    const shown = list.length;
    return (
      `${b.scanned ?? 0}개 종목 ${b.partial ? '백테스트' : '백테스트 완료'} · MA ${period} ${word} ${total}개` +
      (total > shown ? ` (상위 ${shown}개 표시)` : '') +
      (b.partial ? ' · 남은 종목 계속 확인 중…' : b.refreshing ? ' · 새 스캔 진행 중' : '')
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: p.bg }}
        contentContainerStyle={{
          paddingHorizontal: GUTTER,
          paddingBottom: TAB_BAR_SPACER,
          gap: 12,
        }}
      >
        <PageHeader
          title="맞춤 이평선"
          subtitle="내가 고른 선이 지금 버티고 있는 종목 · 막고 있는 종목"
          palette={p}
        />

        {/* 이 화면과 '오늘의 지지선'은 같은 종류라 한 자리에서 오간다 */}
        <Segmented
          options={[
            { value: 'touches', label: '오늘의 지지선' },
            { value: 'lines', label: '맞춤 이평선' },
          ]}
          value="lines"
          palette={p}
          onChange={(v) => {
            if (v === 'touches') {
              navigation.navigate('/screener');
            }
          }}
        />

        <Card palette={p} style={{ gap: 14 }}>
          <View style={{ gap: 8 }}>
            <Text style={{ fontSize: 13, color: p.faint, fontWeight: '600' }}>이평선 기간</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {PERIODS.map((n) => (
                <Chip
                  key={n}
                  label={`${n}일선`}
                  active={period === n}
                  palette={p}
                  onPress={() => setPeriod(n)}
                />
              ))}
            </View>
          </View>
          <Segmented
            options={MARKET_OPTIONS}
            value={market}
            palette={p}
            onChange={(v) => setMarket(v)}
          />
          <Segmented options={SIDE_OPTIONS} value={side} palette={p} onChange={(v) => setSide(v)} />
        </Card>

        <Notice palette={p}>
          {side === 'support'
            ? '선 위에서 움직이던 종목이 그 선 근처까지 내려와 있고, 아직 그 아래로 내려가지 않은 상태예요. 매수·매도 신호가 아니에요.'
            : '선 아래에서 움직이던 종목이 그 선 근처까지 올라와 있고, 아직 그 위로 올라서지 않은 상태예요. 매수·매도 신호가 아니에요.'}
        </Notice>

        <Expandable title="어떤 종목을 골라 주나요?" palette={p}>
          <Text style={{ fontSize: 13.5, color: p.sub, lineHeight: 21 }}>
            다섯 가지를 모두 만족하는 종목만 골라요.{'\n'}
            {'\n'}
            1. 최근 20봉 중 70% 이상이 그 선 {side === 'support' ? '위' : '아래'}에 있었어요
            (추세가 그 선에 정박해 있어야 지지·저항을 말할 수 있어요){'\n'}
            2. 최근 5봉 안에 실제로 그 선에 닿았어요 (지금 시험 중인 종목만){'\n'}
            3. 아직 확정적으로 {side === 'support' ? '무너지지' : '뚫리지'} 않았어요{'\n'}
            4. 선 자체의 기울기가 {side === 'support' ? '하락 중이 아니에요' : '상승 중이 아니에요'}
            {'\n'}
            5. 3년 백테스트에서 그 선의 {word} 판정이 2회 이상, 성공률 50% 이상이에요
          </Text>
          <Text style={{ fontSize: 13.5, color: p.sub, lineHeight: 21, marginTop: 10 }}>
            성공률은 오래된 일보다 최근 일에 더 큰 가중치를 줘서, 요즘 잘 지켜지는 선이
            높게 나옵니다. 그래서 판정 횟수에 성공률을 곱해도 딱 떨어지지 않아요.
          </Text>
        </Expandable>

        {phase === 'boot' ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }}>
            <ActivityIndicator color={p.primary} />
            <Text style={{ fontSize: 14, color: p.sub }}>MA {period} 스캔 확인 중…</Text>
          </View>
        ) : null}

        {phase === 'running' && body ? (
          <Card palette={p} style={{ gap: 12 }}>
            <Text style={{ fontSize: 14, color: p.text, fontWeight: '600' }}>
              {market === 'kr' ? '국내' : '미국'} 종목을 MA {period} 기준으로 백테스트 중…{' '}
              {body.total ? `${body.done ?? 0}/${body.total} 종목` : '대상 선정 중'}
            </Text>
            <View
              style={{ height: 8, borderRadius: 4, backgroundColor: p.sunken, overflow: 'hidden' }}
            >
              <View
                style={{
                  height: 8,
                  width: `${body.total ? Math.round(((body.done ?? 0) / body.total) * 100) : 0}%`,
                  backgroundColor: p.primary,
                }}
              />
            </View>
            <Text style={{ fontSize: 13, color: p.faint, lineHeight: 20 }}>
              처음 고른 기간은 서버가 한 번 훑어야 해요 — 보통 1~2분이면 끝나고, 그 뒤로는
              하루 종일 바로 나옵니다.
            </Text>
          </Card>
        ) : null}

        {phase === 'error' ? (
          <Card palette={p} style={{ gap: 14 }}>
            <Text style={{ fontSize: 14, color: p.danger }}>스캔 실패: {errorMsg}</Text>
            <PrimaryButton
              label="다시 시도"
              palette={p}
              onPress={() => void load(market, period, false)}
            />
          </Card>
        ) : null}

        {phase === 'done' && body ? (
          <>
            <View
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <Text style={{ fontSize: 12, color: p.faint, flexShrink: 1, lineHeight: 18 }}>
                {statusText(body)}
              </Text>
              {!body.partial && !body.refreshing ? (
                <TextButton
                  label="새로고침"
                  size={13}
                  palette={p}
                  onPress={() => void load(market, period, false)}
                />
              ) : null}
            </View>
            {list.length === 0 ? (
              <Card palette={p}>
                <Text style={{ fontSize: 14, color: p.sub, lineHeight: 22 }}>
                  {body.partial
                    ? '남은 종목을 확인하는 중입니다…\n조건에 맞는 종목이 나오면 여기 채워집니다.'
                    : `지금 MA ${period} 선에서 ${word} 중인 종목이 없습니다.\n다른 기간이나 다른 시장을 살펴보세요.`}
                </Text>
              </Card>
            ) : null}
            {list.map((m) => (
              <LineCard
                key={`${m.symbol}-${m.side}`}
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
      {/* 지지선 탭을 켜 두되 실제 위치는 /lines — 그래야 그 탭을 눌러
          '오늘의 지지선'으로 돌아갈 수 있다 (TabBar 주석 참고) */}
      <TabBar
        current="/screener"
        route="/lines"
        palette={p}
        onNavigate={(to) => navigation.navigate(to)}
      />
    </View>
  );
}
