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
import { Card, Chip, Expandable, Footer, PrimaryButton } from '../components/ui';
import { LOOKBACK_LABEL } from '../env';
import { fmtRate } from '../format';
import { pendingAnalyze } from '../store';
import { usePalette } from '../theme';

export const Route = createRoute('/', {
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

function RadarPage() {
  const p = usePalette();
  const navigation = Route.useNavigation();

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SymbolInfo | null>(null);
  const [suggests, setSuggests] = useState<SymbolInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [tf, setTf] = useState<Timeframe>('day');
  const [focusPeriod, setFocusPeriod] = useState<number | null>(null);
  const [showMarkers, setShowMarkers] = useState(true);
  const [maxBars, setMaxBars] = useState<number>(120);

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
    try {
      const body = await analyzeSymbol(item.symbol);
      if (seq !== analyzeSeq.current) {
        return;
      }
      setAnalysis(body);
      setFocusPeriod(null);
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

  // 스크리너 카드에서 "이평선 분석 →" 로 넘어온 경우: 포커스 때 심볼을 읽어 자동 분석
  useEffect(() => {
    const consumePending = () => {
      const sym = pendingAnalyze.symbol;
      if (!sym) {
        return;
      }
      pendingAnalyze.symbol = null;
      void (async () => {
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
        pick(hit, true);
      })();
    };
    consumePending();
    const unsubscribe = navigation.addListener('focus', consumePending);
    return unsubscribe;
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
        .map((rec, i) => ({ rec, color: p.ma[i % p.ma.length] ?? p.indigo }))
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
    <ScrollView
      style={{ flex: 1, backgroundColor: p.bg }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexShrink: 1, paddingRight: 8 }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: p.text }}>📈 이평선 레이더</Text>
          <Text style={{ fontSize: 12, color: p.sub, marginTop: 2 }}>
            자주 지켜진 지지/저항 이평선을 백테스트로 찾아드려요
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => navigation.navigate('/screener')}
          accessibilityRole="button"
          style={{
            borderWidth: 1,
            borderColor: p.border,
            backgroundColor: p.card,
            borderRadius: 10,
            paddingVertical: 8,
            paddingHorizontal: 10,
          }}
        >
          <Text style={{ fontSize: 12, color: p.text, fontWeight: '600' }}>🚨 지지선 터치</Text>
        </TouchableOpacity>
      </View>

      <Card palette={p} style={{ gap: 10 }}>
        <TextInput
          value={query}
          onChangeText={onChangeQuery}
          placeholder="종목 이름 · 코드 · 미국 티커 (예: 삼성전자, AAPL)"
          placeholderTextColor={p.faint}
          autoCorrect={false}
          autoCapitalize="characters"
          style={{
            borderWidth: 1,
            borderColor: p.border,
            borderRadius: 10,
            paddingVertical: 11,
            paddingHorizontal: 12,
            fontSize: 15,
            color: p.text,
          }}
        />
        {suggests.length > 0 ? (
          <View style={{ borderWidth: 1, borderColor: p.border, borderRadius: 10, overflow: 'hidden' }}>
            {suggests.map((item, i) => (
              <TouchableOpacity
                key={`${item.symbol}-${i}`}
                onPress={() => pick(item)}
                accessibilityRole="button"
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  paddingVertical: 11,
                  paddingHorizontal: 12,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: p.border,
                  backgroundColor: p.card,
                }}
              >
                <Text style={{ fontSize: 14, color: p.text, flexShrink: 1, marginRight: 8 }} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={{ fontSize: 12, color: p.faint, flexShrink: 0 }} numberOfLines={1}>
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
          label="분석"
          disabled={!selected || loading}
          palette={p}
          onPress={() => {
            if (selected) {
              void runAnalysis(selected);
            }
          }}
        />
        <Text style={{ fontSize: 11, color: p.faint }}>분석 기간: {LOOKBACK_LABEL}</Text>
      </Card>

      {loading ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }}>
          <ActivityIndicator color={p.up} />
          <Text style={{ fontSize: 13, color: p.sub }}>일봉·주봉·월봉 백테스트 중…</Text>
        </View>
      ) : null}
      {errorMsg ? <Text style={{ fontSize: 13, color: p.down }}>분석 실패: {errorMsg}</Text> : null}

      {analysis && !loading ? (
        <>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {TIMEFRAMES.map((t) => (
              <Chip
                key={t}
                label={TF_LABEL[t]}
                active={tf === t}
                palette={p}
                onPress={() => {
                  setTf(t);
                  setFocusPeriod(null);
                }}
              />
            ))}
          </View>

          {!data || data.error ? (
            <Card palette={p}>
              <Text style={{ fontSize: 13, color: p.down }}>
                {TF_LABEL[tf]} 분석 실패: {data?.error ?? '데이터 없음'}
              </Text>
            </Card>
          ) : (
            <>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {recommended.length > 1 ? (
                  <TouchableOpacity
                    onPress={() => setFocusPeriod(null)}
                    accessibilityRole="button"
                    style={{ flexBasis: '48%', flexGrow: 1, minWidth: 130 }}
                  >
                    <Card
                      palette={p}
                      style={{
                        width: '100%',
                        padding: 10,
                        gap: 3,
                        borderColor: focusPeriod === null ? p.up : p.border,
                      }}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
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
                        <Text style={{ fontSize: 12, fontWeight: '700', color: p.text }}>동시 보기</Text>
                      </View>
                      <Text style={{ fontSize: 10, color: p.sub }}>추천 이평선 전체 표시</Text>
                      <Text style={{ fontSize: 9, color: p.faint }}>
                        {focusPeriod === null ? '지금 보는 중' : '누르면 전체 표시'}
                      </Text>
                    </Card>
                  </TouchableOpacity>
                ) : null}
                {recommended.map((rec, i) => {
                  const color = p.ma[i % p.ma.length] ?? p.indigo;
                  const { breakDown, breakUp } = eventCounts(rec.events);
                  const focused = focusPeriod === rec.period;
                  return (
                    <TouchableOpacity
                      key={rec.period}
                      onPress={() => setFocusPeriod(focused ? null : rec.period)}
                      accessibilityRole="button"
                      style={{ flexBasis: '48%', flexGrow: 1, minWidth: 130 }}
                    >
                      <Card
                        palette={p}
                        style={{
                          width: '100%',
                          padding: 10,
                          gap: 3,
                          borderColor: focused ? p.up : p.border,
                          opacity: focusPeriod !== null && !focused ? 0.55 : 1,
                        }}
                      >
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: color }} />
                          <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>MA {rec.period}</Text>
                        </View>
                        <Text style={{ fontSize: 10, color: p.sub }}>
                          터치 {rec.touches}회 · 지지 성공률 {fmtRate(rec.successRate)}
                        </Text>
                        <Text style={{ fontSize: 10, color: p.sub }}>
                          <Text style={{ color: p.events.support }}>지지 {rec.supportBounces}</Text>
                          {' · '}
                          <Text style={{ color: p.events.resistance }}>저항 {rec.resistanceBounces}</Text>
                          {' · '}
                          <Text style={{ color: p.events.breakDown }}>이탈 {breakDown}</Text>
                          {' · '}
                          <Text style={{ color: p.events.breakUp }}>돌파 {breakUp}</Text>
                        </Text>
                        {rec.qualified ? null : (
                          <Text style={{ fontSize: 9, color: p.amber }}>⚠ 표본 부족 — 참고용</Text>
                        )}
                        <Text style={{ fontSize: 9, color: p.faint }}>
                          {focused ? '누르면 전체 보기' : '누르면 이 선만 보기'}
                        </Text>
                      </Card>
                    </TouchableOpacity>
                  );
                })}
                {recommended.length === 0 ? (
                  <Card palette={p} style={{ flexBasis: '100%' }}>
                    <Text style={{ fontSize: 12, color: p.amber }}>
                      추천할 만한 이평선을 찾지 못했습니다 (데이터/터치 부족)
                    </Text>
                  </Card>
                ) : null}
              </View>

              <Text style={{ fontSize: 11, color: p.faint }}>
                분석 구간: {data.windowStart} ~ {data.windowEnd} ({TF_LABEL[tf]} {data.bars}개
                {data.lookbackYears ? `, 약 ${data.lookbackYears}년` : ', 전체 기간'}) · 최근 가중 반감기{' '}
                {data.halfLifeBars}봉
              </Text>

              <Card palette={p} style={{ gap: 10 }}>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 8,
                  }}
                >
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    {BAR_OPTIONS.map((n) => (
                      <Chip
                        key={n}
                        label={`${n}봉`}
                        active={maxBars === n}
                        palette={p}
                        onPress={() => setMaxBars(n)}
                      />
                    ))}
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ fontSize: 12, color: p.sub }}>지지/저항 마커</Text>
                    <Switch
                      value={showMarkers}
                      onValueChange={setShowMarkers}
                      trackColor={{ true: p.up, false: p.border }}
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
                <Text style={{ fontSize: 10, color: p.faint }}>
                  ▲=지지 성공 · ▼=저항 성공 · ●=뚫림 (초록=상승성 · 빨강=하락성) · 최근 {maxBars}봉 표시
                </Text>
              </Card>

              <Card palette={p} style={{ gap: 8 }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: p.text }}>
                  전체 후보 성적표 — {TF_LABEL[tf]}
                </Text>
                <ScoreTable
                  stats={data.stats ?? []}
                  recommended={recommended.map((r) => r.period)}
                  palette={p}
                />
              </Card>
            </>
          )}
        </>
      ) : null}

      {!analysis && !loading && !errorMsg ? (
        <Expandable title="어떻게 쓰나요?" palette={p}>
          <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19 }}>
            1. 종목을 검색하거나 대표 종목을 누르세요{'\n'}
            2. 일봉·주봉·월봉별로 가장 자주, 믿을 만하게 지지/저항 역할을 해온 이동평균선 2~3개를
            백테스트로 찾아 차트에 그려드려요{'\n'}
            3. 남들이 쓰는 20·60일선이 아니라, 이 종목이 실제로 지켜온 선을 확인하세요
          </Text>
        </Expandable>
      ) : null}

      <Footer palette={p} />
    </ScrollView>
  );
}
