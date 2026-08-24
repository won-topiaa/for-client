import { createRoute } from '@granite-js/react-native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { clearSession, fetchTouches, getToken, isAuthError, logout, me } from '../api/client';
import type { Market, TouchesResponse, TouchMatch } from '../api/types';
import { CandleChart } from '../components/CandleChart';
import { Card, Chip, Expandable, Footer, PrimaryButton } from '../components/ui';
import { SCREENER_RULE_LABEL } from '../env';
import { fmtDistPct, fmtPrice, fmtRate } from '../format';
import { pendingAnalyze } from '../store';
import { usePalette } from '../theme';

export const Route = createRoute('/screener', {
  component: ScreenerPage,
});

type Phase = 'boot' | 'needLogin' | 'running' | 'done' | 'error';

const POLL_RUNNING_MS = 2000; // 스캔 진행 중 폴링 간격 (웹과 동일)
const POLL_PARTIAL_MS = 5000; // 부분 결과가 채워지는 동안
const RETRY_ERROR_MS = 15000;

function ScreenerPage() {
  const p = usePalette();
  const navigation = Route.useNavigation();

  const [market, setMarket] = useState<Market>('kr');
  const [phase, setPhase] = useState<Phase>('boot');
  const [body, setBody] = useState<TouchesResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [email, setEmail] = useState<string | null>(null);

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
      const token = await getToken();
      if (!token) {
        if (seq === seqRef.current) {
          setPhase('needLogin');
        }
        return;
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
        if (isAuthError(err)) {
          await clearSession(); // 만료 토큰 정리 후 로그인 유도
          setPhase('needLogin');
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
    void me().then(setEmail);
    return () => {
      // 진행 중이던 응답이 화면을 떠난 뒤 도착해 타이머를 다시 걸지 않도록
      // 시퀀스를 올려 무효화한다 (타이머만 지우면 폴링이 몰래 계속된다)
      seqRef.current++;
      clearTimer();
    };
  }, [market, load]);

  // 로그인 화면에서 돌아오면 다시 시도
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      void (async () => {
        if ((await getToken()) && (phase === 'needLogin' || phase === 'error')) {
          void me().then(setEmail);
          void load(market, false);
        }
      })();
    });
    return unsubscribe;
  }, [navigation, phase, market, load]);

  const statusText = (b: TouchesResponse): string => {
    const shown = (b.matches ?? []).length;
    const total = b.totalMatches ?? 0;
    return (
      `${b.scanned}개 종목 ${b.partial ? '백테스트' : '백테스트 완료'} · 오늘 지지선 터치 ${total}개` +
      (total > shown ? ` (상위 ${shown}개 표시)` : '') +
      (b.partial ? ' · 남은 종목 계속 확인 중…' : b.refreshing ? ' · 백그라운드에서 새 스캔 진행 중' : '')
    );
  };

  const openRadar = (m: TouchMatch) => {
    pendingAnalyze.symbol = m.symbol;
    navigation.navigate('/radar');
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: p.bg }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexShrink: 1 }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: p.text }}>오늘의 지지선</Text>
          <Text style={{ fontSize: 12, color: p.sub, marginTop: 2 }}>
            검증된 지지 이평선에 오늘 저가가 닿은 종목만
          </Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
          {email ? (
            <TouchableOpacity
              onPress={() => {
                void logout().then(() => {
                  setEmail(null);
                  setPhase('needLogin');
                });
              }}
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
              <Text style={{ fontSize: 11, color: p.sub }}>로그아웃</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            onPress={() => navigation.navigate('/')}
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
            <Text style={{ fontSize: 12, color: p.text, fontWeight: '600' }}>홈</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: 6 }}>
        <Chip label="🇰🇷 국내" active={market === 'kr'} palette={p} onPress={() => setMarket('kr')} />
        <Chip label="🇺🇸 미국" active={market === 'us'} palette={p} onPress={() => setMarket('us')} />
      </View>

      <Expandable title="스캔 기준" palette={p}>
        <Text style={{ fontSize: 11, color: p.faint, lineHeight: 16 }}>
          {SCREENER_RULE_LABEL} 인정합니다. 5일선은 제외 — 단기선은 지지 신뢰도가 낮습니다.
        </Text>
      </Expandable>

      {phase === 'needLogin' ? (
        <Card palette={p} style={{ gap: 10 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: p.text }}>회원 전용(무료) 기능이에요</Text>
          <PrimaryButton label="로그인 / 회원가입" palette={p} onPress={() => navigation.navigate('/login')} />
          <Expandable title="자세히 보기" palette={p}>
            <Text style={{ fontSize: 12, color: p.sub, lineHeight: 18 }}>
              이메일로 가입하면 매일 시장 전체(국내 거래대금 상위 · 미국 S&P500급)를 스캔한 결과를 볼 수
              있어요. 주식 레이더 사이트와 계정을 같이 씁니다.
            </Text>
          </Expandable>
        </Card>
      ) : null}

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
          {(body.matches ?? []).map((m) => {
            const ratePct = Math.max(0, Math.min(100, Math.round(m.successRate * 100)));
            return (
              <Card key={`${m.symbol}-${m.period}`} palette={p} style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ fontSize: 15, color: p.text, flexShrink: 1 }} numberOfLines={1}>
                    <Text style={{ fontWeight: '800' }}>{m.name}</Text>
                    <Text style={{ fontSize: 12, color: p.faint }}>
                      {'  '}
                      {m.symbol}
                      {m.market ? ` · ${m.market}` : ''}
                    </Text>
                  </Text>
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
                </View>
                <View style={{ height: 6, borderRadius: 3, backgroundColor: p.border, overflow: 'hidden' }}>
                  <View style={{ height: 6, width: `${ratePct}%`, backgroundColor: p.up }} />
                </View>
                <Text style={{ fontSize: 12, color: p.sub, lineHeight: 18 }}>
                  3년 지지 성공률 <Text style={{ fontWeight: '700', color: p.text }}>{fmtRate(m.successRate)}</Text>
                  {' · '}지지 성공 {m.supportBounces}회 (터치 {m.touches}회){' · '}오늘 종가는 선 대비{' '}
                  <Text style={{ fontWeight: '700', color: p.text }}>{fmtDistPct(m.distPct)}</Text> (선{' '}
                  {fmtPrice(m.maValue)})
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
                  onPress={() => openRadar(m)}
                  accessibilityRole="button"
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Text style={{ fontSize: 13, color: p.indigo, fontWeight: '600' }}>이평선 분석 →</Text>
                </TouchableOpacity>
              </Card>
            );
          })}
        </>
      ) : null}

      <Footer palette={p} />
    </ScrollView>
  );
}
