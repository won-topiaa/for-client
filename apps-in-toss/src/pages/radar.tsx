import { createRoute } from '@granite-js/react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { analyzeSymbol, searchSymbols } from '../api/client';
import type { AnalyzeResponse, MAEvent, SymbolInfo, Timeframe } from '../api/types';
import { CandleChart, type ChartLine, type ChartMarker } from '../components/CandleChart';
import { ScoreTable } from '../components/ScoreTable';
import { TabBar, TAB_BAR_SPACER } from '../components/TabBar';
import {
  Card,
  Chip,
  Expandable,
  Footer,
  InlineToggle,
  Notice,
  PageHeader,
  PrimaryButton,
  Segmented,
  StarButton,
  TextButton,
} from '../components/ui';
import { LOG } from '../analytics';
import { LOOKBACK_LABEL } from '../env';
import { fmtRate } from '../format';
import { lastAnalysis, pendingAnalyze } from '../store';
import { GUTTER, RADIUS, usePalette, type Palette } from '../theme';
import { isWatched, useWatchlist } from '../watchlist';

export const Route = createRoute('/radar', {
  component: RadarPage,
});

const TF_LABEL: Record<Timeframe, string> = { day: '일봉', week: '주봉', month: '월봉' };
const TIMEFRAMES: Timeframe[] = ['day', 'week', 'month'];
const BAR_OPTIONS = [60, 120, 240] as const;

// 웹(/ma)의 대표 종목 바로 분석과 같은 목록
const QUICK_PICKS: SymbolInfo[] = [
  { symbol: '005930', name: '삼성전자', market: 'KOSPI' },
  { symbol: '000660', name: 'SK하이닉스', market: 'KOSPI' },
  { symbol: '373220', name: 'LG에너지솔루션', market: 'KOSPI' },
  { symbol: '005380', name: '현대차', market: 'KOSPI' },
  { symbol: '035420', name: 'NAVER', market: 'KOSPI' },
  { symbol: 'AAPL', name: '애플', market: 'NASDAQ' },
  { symbol: 'NVDA', name: '엔비디아', market: 'NASDAQ' },
  { symbol: 'MSFT', name: '마이크로소프트', market: 'NASDAQ' },
  { symbol: 'TSLA', name: '테슬라', market: 'NASDAQ' },
  { symbol: 'GOOGL', name: '알파벳(구글)', market: 'NASDAQ' },
];

/**
 * 차트 마커 범례 한 칸 — 차트에 실제로 그려지는 모양·색을 그대로 재현한다.
 * (CandleChart 의 마커와 같은 방식: 삼각형은 테두리 트릭, 뚫림은 원)
 */
function MarkerLegend({
  shape,
  color,
  label,
  palette: p,
}: {
  shape: 'up' | 'down' | 'dot';
  color: string;
  label: string;
  palette: Palette;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      {shape === 'dot' ? (
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      ) : (
        <View
          style={{
            width: 0,
            height: 0,
            borderLeftWidth: 5,
            borderRightWidth: 5,
            borderLeftColor: 'transparent',
            borderRightColor: 'transparent',
            ...(shape === 'up'
              ? { borderBottomWidth: 8, borderBottomColor: color }
              : { borderTopWidth: 8, borderTopColor: color }),
          }}
        />
      )}
      <Text style={{ fontSize: 12, color: p.sub }}>{label}</Text>
    </View>
  );
}

function RadarPage() {
  const p = usePalette();
  const navigation = Route.useNavigation();

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SymbolInfo | null>(null);
  const [suggests, setSuggests] = useState<SymbolInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  // 분석한 종목의 표시 정보. selected 를 그대로 쓰면 안 된다 — 결과를 띄워 둔 채
  // 검색어를 새로 입력하면 selected 가 null 이 돼(onChangeQuery) 카드가 종목명
  // 대신 심볼을 보여주고, 그 상태로 별을 누르면 이름이 심볼로 저장된다.
  const [analyzed, setAnalyzed] = useState<SymbolInfo | null>(null);
  const [tf, setTf] = useState<Timeframe>('day');
  const [focusPeriod, setFocusPeriod] = useState<number | null>(null);
  const [showMarkers, setShowMarkers] = useState(true);
  const [maxBars, setMaxBars] = useState<number>(120);
  // 통계 밀도 2단 구조: 기본은 '몇 번 중 몇 번 성공'만 보여주고, 반감기·
  // 지지/저항/이탈/돌파 내역·전체 성적표는 이 토글을 켠 사람에게만 보여준다.
  // (초보는 숫자가 많으면 읽기를 포기하고, 전문가는 다 보고 싶어 한다)
  const [showStats, setShowStats] = useState(false);
  const { items: watched, toggle: toggleWatch } = useWatchlist();

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeq = useRef(0);
  const analyzeSeq = useRef(0);

  /* ---------- 검색 ---------- */

  const hideSuggest = useCallback(() => {
    if (searchTimer.current) {
      clearTimeout(searchTimer.current);
    }
    searchSeq.current++;
    setSuggests([]);
  }, []);

  const onChangeQuery = (text: string) => {
    // 여기서 바로 시퀀스를 올린다. 디바운스 콜백 안에서만 올리면, 사용자가
    // 계속 타이핑하는 동안(타이머가 매번 리셋돼 콜백이 안 돔) 시퀀스가 그대로라
    // 자동 분석용 사전 검색이 늦게 도착해 사용자의 입력을 덮어쓴다.
    searchSeq.current++;
    setQuery(text);
    setSelected(null);
    if (searchTimer.current) {
      clearTimeout(searchTimer.current);
    }
    const q = text.trim();
    if (!q) {
      hideSuggest();
      return;
    }
    searchTimer.current = setTimeout(async () => {
      const seq = ++searchSeq.current;
      let items: SymbolInfo[] = [];
      try {
        items = (await searchSymbols(q)).results;
      } catch {
        items = [];
      }
      if (seq !== searchSeq.current) {
        return; // 더 최신 검색이 시작됨 — 이 응답 폐기
      }
      setSuggests(items.slice(0, 8));
    }, 250);
  };

  const runAnalysis = useCallback(async (item: SymbolInfo) => {
    const seq = ++analyzeSeq.current;
    setLoading(true);
    setErrorMsg('');
    setAnalysis(null);
    setAnalyzed(null);
    try {
      const body = await analyzeSymbol(item.symbol);
      if (seq !== analyzeSeq.current) {
        return;
      }
      setAnalysis(body);
      setAnalyzed(item);
      setFocusPeriod(null);
      // 떠났다 돌아왔을 때 즉시 되살릴 수 있게 남겨 둔다 (아래 복원 참고)
      lastAnalysis.value = { symbol: item.symbol, info: item, body };
    } catch (err) {
      if (seq === analyzeSeq.current) {
        setErrorMsg(err instanceof Error ? err.message : '분석에 실패했어요.');
      }
    } finally {
      if (seq === analyzeSeq.current) {
        setLoading(false);
      }
    }
  }, []);

  const pick = useCallback(
    (item: SymbolInfo, andAnalyze?: boolean) => {
      setSelected(item);
      setQuery(`${item.name} (${item.symbol})`);
      hideSuggest();
      if (andAnalyze) {
        void runAnalysis(item);
      }
    },
    [hideSuggest, runAnalysis]
  );

  // 방금 보던 분석을 되살린다 — 탭바로 잠깐 나갔다 온 사람이 빈 화면을 보지
  // 않게. 다른 화면에서 종목을 지정해 들어온 경우(pendingAnalyze)는 그쪽이
  // 우선이므로 건드리지 않는다.
  useEffect(() => {
    if (pendingAnalyze.symbol) {
      return;
    }
    const saved = lastAnalysis.value;
    if (!saved) {
      return;
    }
    setAnalysis(saved.body as AnalyzeResponse);
    setAnalyzed(saved.info);
    setSelected(saved.info);
    setQuery(`${saved.info.name} (${saved.info.symbol})`);
  }, []);

  // 스크리너 카드에서 "이평선 분석 →" 로 넘어온 경우: 포커스 때 심볼을 읽어 자동 분석
  useEffect(() => {
    // 화면을 떠난 뒤 늦게 끝난 검색이 분석(서버에서 가장 무거운 요청)을 시작하지 않게
    let alive = true;
    const consumePending = () => {
      const sym = pendingAnalyze.symbol;
      if (!sym) {
        return;
      }
      pendingAnalyze.symbol = null;
      void (async () => {
        // 이 검색이 도는 동안 사용자가 직접 다른 종목을 고를 수 있다. 그때는
        // 늦게 도착한 이 결과가 사용자의 선택을 덮어쓰고 엉뚱한 종목을 분석해
        // 버린다 — 시퀀스를 잡아 두고, 그 사이 검색/선택이 있었으면 물러난다.
        // (pick·hideSuggest·입력이 모두 searchSeq 를 올린다.)
        const mySeq = ++searchSeq.current;
        // 정확히 같은 심볼만 쓴다 — 첫 결과로 폴백하면 검색 노이즈에 밀려
        // 엉뚱한 종목(예: KR 카드 → KHC 분석)이 될 수 있다. 검색은 표시용
        // 이름을 얻는 수단일 뿐이므로, 못 찾으면(또는 검색이 실패하면)
        // 심볼 그대로 분석한다 (분석 API 는 원시 심볼을 받는다).
        let hit: SymbolInfo = { symbol: sym, name: sym };
        try {
          const body = await searchSymbols(sym);
          hit = body.results.find((x) => x.symbol === sym) ?? hit;
        } catch {
          // 검색 실패 → 심볼 그대로 진행
        }
        if (!alive || mySeq !== searchSeq.current) {
          return; // 화면을 떠났거나, 사용자가 그 사이에 다른 종목을 골랐다
        }
        pick(hit, true);
      })();
    };
    consumePending();
    const unsubscribe = navigation.addListener('focus', consumePending);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [navigation, pick]);

  /* ---------- 현재 타임프레임 데이터 ---------- */

  const data = analysis?.timeframes[tf];
  const recommended = useMemo(() => data?.recommended ?? [], [data]);
  const visibleRecs = useMemo(
    () => (focusPeriod === null ? recommended : recommended.filter((r) => r.period === focusPeriod)),
    [recommended, focusPeriod]
  );

  const chartLines: ChartLine[] = useMemo(
    () =>
      recommended
        .map((rec, i) => ({ rec, color: p.ma[i % p.ma.length] ?? p.primary }))
        .filter(({ rec }) => focusPeriod === null || rec.period === focusPeriod)
        .map(({ rec, color }) => ({
          color,
          points: rec.ma,
          width: focusPeriod === null ? 2 : 3,
        })),
    [recommended, focusPeriod, p]
  );

  const chartMarkers: ChartMarker[] = useMemo(() => {
    if (!showMarkers) {
      return [];
    }
    const markers: (ChartMarker & { t: string })[] = [];
    for (const rec of visibleRecs) {
      for (const ev of rec.events) {
        if (ev.outcome === 'undecided') {
          continue;
        }
        const isSupport = ev.side === 'support';
        const failed = ev.outcome === 'break';
        markers.push({
          t: ev.time,
          time: ev.time,
          position: isSupport ? 'below' : 'above',
          shape: failed ? 'circle' : isSupport ? 'arrowUp' : 'arrowDown',
          color: failed
            ? isSupport
              ? p.events.breakDown
              : p.events.breakUp
            : isSupport
              ? p.events.support
              : p.events.resistance,
        });
      }
    }
    markers.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
    return markers.slice(-120);
  }, [visibleRecs, showMarkers, p]);

  const eventCounts = (events: MAEvent[]) => {
    const breakDown = events.filter((e) => e.outcome === 'break' && e.side === 'support').length;
    const breakUp = events.filter((e) => e.outcome === 'break' && e.side === 'resistance').length;
    return { breakDown, breakUp };
  };

  /* ---------- 렌더 ---------- */

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: p.bg }}
        contentContainerStyle={{
          paddingHorizontal: GUTTER,
          paddingBottom: TAB_BAR_SPACER,
          gap: 12,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {/* 홈·관심종목 이동은 하단 탭바가 맡는다 */}
        <PageHeader
          title="내 종목 이평선"
          subtitle="자주 지켜진 지지/저항 이평선을 백테스트로 찾아드려요"
          palette={p}
        />

        <Card palette={p} style={{ gap: 12 }}>
          {/* 토스의 입력창처럼 테두리 없이 '눌러 들어간' 회색 면으로 그린다 */}
          <TextInput
            value={query}
            onChangeText={onChangeQuery}
            placeholder="종목 이름 · 코드 · 티커 (예: 삼성전자, AAPL)"
            placeholderTextColor={p.faint}
            autoCorrect={false}
            autoCapitalize="characters"
            // 다크 화면에 흰 키보드가 올라오면 그 순간만 눈이 부신다 (iOS)
            keyboardAppearance={p.dark ? 'dark' : 'light'}
            style={{
              backgroundColor: p.sunken,
              borderRadius: RADIUS.input,
              paddingVertical: 14,
              paddingHorizontal: 16,
              fontSize: 16,
              color: p.text,
            }}
          />
          {/* 자동완성 목록. 흰 카드 안이라 배경까지 흰색이면 목록의 경계가
              사라진다 — 눌러 들어간 회색 면에 얹어 '고를 것들'로 보이게 한다 */}
          {suggests.length > 0 ? (
            <View style={{ backgroundColor: p.sunken, borderRadius: 12, overflow: 'hidden' }}>
              {suggests.map((item, i) => (
                <TouchableOpacity
                  key={`${item.symbol}-${i}`}
                  onPress={() => pick(item)}
                  accessibilityRole="button"
                  activeOpacity={0.6}
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    paddingVertical: 13,
                    paddingHorizontal: 14,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: p.border,
                  }}
                >
                  <Text
                    style={{ fontSize: 15, color: p.text, flexShrink: 1, marginRight: 8 }}
                    numberOfLines={1}
                  >
                    {item.name}
                  </Text>
                  <Text style={{ fontSize: 13, color: p.faint, flexShrink: 0 }} numberOfLines={1}>
                    {item.symbol}
                    {item.market ? ` · ${item.market}` : ''}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {QUICK_PICKS.map((q) => (
              <Chip
                key={q.symbol}
                label={q.name}
                active={selected?.symbol === q.symbol}
                palette={p}
                onPress={() => pick(q, true)}
              />
            ))}
          </View>
          <PrimaryButton
            label="분석하기"
            disabled={!selected || loading}
            palette={p}
            logName={LOG.analyze}
            onPress={() => {
              if (selected) {
                void runAnalysis(selected);
              }
            }}
          />
          <Text style={{ fontSize: 12, color: p.faint }}>분석 기간: {LOOKBACK_LABEL}</Text>
        </Card>

        {/* 1.3.5 차트 사진 분석 — 방금 본 종목이 미리 골라져 있다 */}
        <View style={{ alignItems: 'flex-end' }}>
          <TextButton
            label="차트 사진으로 설명 듣기 →"
            palette={p}
            logName={LOG.openFeature}
            onPress={() => navigation.navigate('/photo')}
          />
        </View>

        {loading ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }}>
            <ActivityIndicator color={p.primary} />
            <Text style={{ fontSize: 14, color: p.sub }}>일봉·주봉·월봉 백테스트 중…</Text>
          </View>
        ) : null}
        {errorMsg ? (
          <Text style={{ fontSize: 14, color: p.danger }}>분석 실패: {errorMsg}</Text>
        ) : null}

        {analysis && !loading ? (
          <>
            {/* 분석한 종목 — 오른쪽 위 별로 관심종목에 담는다 */}
            <Card palette={p} style={{ paddingVertical: 16 }}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <View style={{ flexShrink: 1, paddingRight: 8 }}>
                  <Text style={{ fontSize: 18, fontWeight: '700', color: p.text }} numberOfLines={1}>
                    {analyzed?.name ?? analysis.symbol}
                  </Text>
                  <Text style={{ fontSize: 13, color: p.faint, marginTop: 3 }}>
                    {analysis.symbol}
                    {analyzed?.market ? ` · ${analyzed.market}` : ''}
                  </Text>
                </View>
                <StarButton
                  watched={isWatched(watched, analysis.symbol)}
                  palette={p}
                  label={analyzed?.name ?? analysis.symbol}
                  logName={LOG.watchlistAdd}
                  onPress={() => {
                    void toggleWatch({
                      symbol: analysis.symbol,
                      name: analyzed?.name ?? analysis.symbol,
                      market: analyzed?.market,
                    });
                  }}
                />
              </View>
            </Card>

            <Segmented
              options={TIMEFRAMES.map((t) => ({ value: t, label: TF_LABEL[t] }))}
              value={tf}
              palette={p}
              onChange={(t) => {
                setTf(t);
                setFocusPeriod(null);
              }}
            />

            {!data || data.error ? (
              <Card palette={p}>
                <Text style={{ fontSize: 14, color: p.danger }}>
                  {TF_LABEL[tf]} 분석 실패: {data?.error ?? '데이터 없음'}
                </Text>
              </Card>
            ) : (
              <>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {recommended.length > 1 ? (
                    <TouchableOpacity
                      onPress={() => setFocusPeriod(null)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: focusPeriod === null }}
                      activeOpacity={0.7}
                      style={{ flexBasis: '48%', flexGrow: 1, minWidth: 140 }}
                    >
                      {/* 선택 상태는 테두리가 아니라 옅은 파란 면으로 나타낸다 —
                          토스는 선택을 색면으로 보여 주고 테두리를 거의 쓰지 않는다 */}
                      <Card
                        palette={p}
                        style={{
                          width: '100%',
                          padding: 14,
                          gap: 4,
                          backgroundColor: focusPeriod === null ? p.primaryBg : p.card,
                        }}
                      >
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          {recommended.map((_, i) => (
                            <View
                              key={i}
                              style={{
                                width: 7,
                                height: 7,
                                borderRadius: 3.5,
                                backgroundColor: p.ma[i % p.ma.length],
                              }}
                            />
                          ))}
                          <Text style={{ fontSize: 14, fontWeight: '700', color: p.text }}>
                            동시 보기
                          </Text>
                        </View>
                        <Text style={{ fontSize: 12, color: p.sub }}>추천 이평선 전체 표시</Text>
                        <Text style={{ fontSize: 11.5, color: p.faint }}>
                          {focusPeriod === null ? '지금 보는 중' : '누르면 전체 표시'}
                        </Text>
                      </Card>
                    </TouchableOpacity>
                  ) : null}
                  {recommended.map((rec, i) => {
                    const color = p.ma[i % p.ma.length] ?? p.primary;
                    const { breakDown, breakUp } = eventCounts(rec.events);
                    const focused = focusPeriod === rec.period;
                    return (
                      <TouchableOpacity
                        key={rec.period}
                        onPress={() => setFocusPeriod(focused ? null : rec.period)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: focused }}
                        activeOpacity={0.7}
                        style={{ flexBasis: '48%', flexGrow: 1, minWidth: 140 }}
                      >
                        <Card
                          palette={p}
                          style={{
                            width: '100%',
                            padding: 14,
                            gap: 4,
                            backgroundColor: focused ? p.primaryBg : p.card,
                            opacity: focusPeriod !== null && !focused ? 0.55 : 1,
                          }}
                        >
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                            <View
                              style={{
                                width: 7,
                                height: 7,
                                borderRadius: 3.5,
                                backgroundColor: color,
                              }}
                            />
                            <Text style={{ fontSize: 15, fontWeight: '700', color: p.text }}>
                              MA {rec.period}
                            </Text>
                          </View>
                          <Text style={{ fontSize: 12, color: p.sub, lineHeight: 18 }}>
                            {/* 기본 표기는 '몇 번 중 몇 번' — 비율만 있으면 표본이
                                2회인지 200회인지 모른 채 숫자를 믿게 된다.
                                분모는 supportTests (touches 는 저항 포함이라 안 맞다). */}
                            지지 시험 {rec.supportTests}회 중 {rec.supportBounces}회 성공 (
                            {fmtRate(rec.supportRate)})
                          </Text>
                          {showStats ? (
                            <Text style={{ fontSize: 12, color: p.sub }}>
                              <Text style={{ color: p.events.support }}>
                                지지 {rec.supportBounces}
                              </Text>
                              {' · '}
                              <Text style={{ color: p.events.resistance }}>
                                저항 {rec.resistanceBounces}
                              </Text>
                              {' · '}
                              <Text style={{ color: p.events.breakDown }}>이탈 {breakDown}</Text>
                              {' · '}
                              <Text style={{ color: p.events.breakUp }}>돌파 {breakUp}</Text>
                            </Text>
                          ) : null}
                          {rec.qualified ? null : (
                            <Text style={{ fontSize: 11.5, color: p.warnText }}>
                              ⚠ 표본 부족 — 참고용
                            </Text>
                          )}
                          <Text style={{ fontSize: 11.5, color: p.faint }}>
                            {focused ? '누르면 전체 보기' : '누르면 이 선만 보기'}
                          </Text>
                        </Card>
                      </TouchableOpacity>
                    );
                  })}
                  {recommended.length === 0 ? (
                    <Card palette={p} style={{ flexBasis: '100%' }}>
                      <Text style={{ fontSize: 14, color: p.sub, lineHeight: 22 }}>
                        추천할 만한 이평선을 찾지 못했습니다 (데이터·터치 부족)
                      </Text>
                    </Card>
                  ) : null}
                </View>

                {/* 성공률을 '오를 확률'로 읽지 않게 — 카드 바로 아래 한 번만 */}
                <Notice palette={p}>
                  성공률은 과거에 이 선에서 몇 번 버텼는지를 센 통계예요. 앞으로도 그렇다는
                  보장이나 매수 신호가 아닙니다.
                </Notice>

                {/* 숫자 자세히 — 기본은 접어 둔다 (반감기·이벤트 내역·성적표) */}
                <InlineToggle
                  open={showStats}
                  label="숫자 자세히"
                  palette={p}
                  onPress={() => setShowStats((v) => !v)}
                />
                {showStats ? (
                  <Text style={{ fontSize: 12, color: p.faint, lineHeight: 18 }}>
                    분석 구간: {data.windowStart} ~ {data.windowEnd} ({TF_LABEL[tf]} {data.bars}개
                    {data.lookbackYears ? `, 약 ${data.lookbackYears}년` : ', 전체 기간'}) · 최근
                    가중 반감기 {data.halfLifeBars}봉
                  </Text>
                ) : null}

                <Card palette={p} style={{ gap: 14 }}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Segmented
                        options={BAR_OPTIONS.map((n) => ({ value: n, label: `${n}봉` }))}
                        value={maxBars}
                        palette={p}
                        onChange={setMaxBars}
                      />
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={{ fontSize: 13, color: p.sub }}>마커</Text>
                      <Switch
                        value={showMarkers}
                        onValueChange={setShowMarkers}
                        trackColor={{ true: p.primary, false: p.border }}
                      />
                    </View>
                  </View>
                  <CandleChart
                    candles={data.candles ?? []}
                    lines={chartLines}
                    markers={chartMarkers}
                    height={300}
                    maxBars={maxBars}
                    colors={{ up: p.up, down: p.down, grid: p.grid, text: p.faint }}
                  />
                  {/* 마커 범례 — 차트에 그려지는 모양과 색을 그대로 옆에 세워 둔다.
                      흑백 글자 한 줄로만 설명하면 색과 뜻을 머릿속에서 맞춰야 한다. */}
                  {showMarkers ? (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
                      <MarkerLegend
                        shape="up"
                        color={p.events.support}
                        label="지지 성공"
                        palette={p}
                      />
                      <MarkerLegend
                        shape="down"
                        color={p.events.resistance}
                        label="저항 성공"
                        palette={p}
                      />
                      <MarkerLegend
                        shape="dot"
                        color={p.events.breakDown}
                        label="지지 뚫림"
                        palette={p}
                      />
                      <MarkerLegend
                        shape="dot"
                        color={p.events.breakUp}
                        label="저항 뚫림"
                        palette={p}
                      />
                    </View>
                  ) : null}
                  <Text style={{ fontSize: 12, color: p.faint }}>최근 {maxBars}봉 표시</Text>
                </Card>

                {/* 전체 후보 성적표는 열이 빽빽해 초보에겐 벽이다 — '숫자 자세히'
                    를 켠 사람에게만 보여준다 */}
                {showStats ? (
                  <Card palette={p} style={{ gap: 12 }}>
                    <Text style={{ fontSize: 16, fontWeight: '700', color: p.text }}>
                      전체 후보 성적표 — {TF_LABEL[tf]}
                    </Text>
                    <ScoreTable
                      stats={data.stats ?? []}
                      recommended={recommended.map((r) => r.period)}
                      palette={p}
                    />
                  </Card>
                ) : null}
              </>
            )}
          </>
        ) : null}

        {!analysis && !loading && !errorMsg ? (
          <Expandable title="어떻게 쓰나요?" palette={p}>
            <Text style={{ fontSize: 14, color: p.sub, lineHeight: 22 }}>
              1. 종목을 검색하거나 대표 종목을 누르세요{'\n'}
              2. 일봉·주봉·월봉별로 가장 자주, 믿을 만하게 지지/저항 역할을 해온 이동평균선
              2~3개를 백테스트로 찾아 차트에 그려드려요{'\n'}
              3. 남들이 쓰는 20·60일선이 아니라, 이 종목이 실제로 지켜온 선을 확인하세요
            </Text>
          </Expandable>
        ) : null}

        <Footer palette={p} />
      </ScrollView>
      <TabBar current="/radar" palette={p} onNavigate={(to) => navigation.navigate(to)} />
    </View>
  );
}
