import { createRoute } from '@granite-js/react-native';
import React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Card, Footer } from '../components/ui';
import { usePalette } from '../theme';

export const Route = createRoute('/', {
  component: HomePage,
});

function HomePage() {
  const p = usePalette();
  const navigation = Route.useNavigation();

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: p.bg }}
      contentContainerStyle={{ padding: 16, gap: 16 }}
    >
      <View style={{ paddingVertical: 12 }}>
        <Text style={{ fontSize: 24, fontWeight: '800', color: p.text }}>
          이평선 레이더
        </Text>
        <Text style={{ fontSize: 13, color: p.sub, marginTop: 4, lineHeight: 20 }}>
          종목마다 실제로 지켜진 이동평균선을 백테스트로 찾아드려요
        </Text>
      </View>

      {/* ── 기능 1: 내 종목 이평선 ── */}
      <TouchableOpacity
        onPress={() => navigation.navigate('/radar')}
        accessibilityRole="button"
        activeOpacity={0.7}
      >
        <Card palette={p} style={{ gap: 12, borderColor: p.up, borderWidth: 1.5 }}>
          <Text style={{ fontSize: 18, fontWeight: '800', color: p.text }}>
            내 종목 이평선
          </Text>
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Text style={{ fontSize: 20 }}>🔍</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
                  종목을 검색하세요
                </Text>
                <Text style={{ fontSize: 12, color: p.sub, lineHeight: 18, marginTop: 2 }}>
                  관심 종목의 이름이나 코드를 입력하면 자동으로 분석이 시작돼요.
                  한국·미국 주식 모두 가능합니다.
                </Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Text style={{ fontSize: 20 }}>📊</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
                  핵심 이평선을 찾아드려요
                </Text>
                <Text style={{ fontSize: 12, color: p.sub, lineHeight: 18, marginTop: 2 }}>
                  일봉·주봉·월봉 3년치 데이터를 백테스트해서, 이 종목에서 가장 자주
                  지지/저항 역할을 해온 이동평균선 2~3개를 골라줍니다.
                </Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Text style={{ fontSize: 20 }}>💡</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
                  투자에 이렇게 써보세요
                </Text>
                <Text style={{ fontSize: 12, color: p.sub, lineHeight: 18, marginTop: 2 }}>
                  남들이 쓰는 20·60일선이 아니라, 이 종목이 실제로 지켜온 선을
                  확인하세요. 차트에서 지지/저항 마커로 과거에 어떻게 반응했는지
                  한눈에 볼 수 있어요.
                </Text>
              </View>
            </View>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
            <Text style={{ fontSize: 13, color: p.up, fontWeight: '700' }}>
              종목 분석하기 →
            </Text>
          </View>
        </Card>
      </TouchableOpacity>

      {/* ── 기능 2: 오늘의 지지선 ── */}
      <TouchableOpacity
        onPress={() => navigation.navigate('/screener')}
        accessibilityRole="button"
        activeOpacity={0.7}
      >
        <Card palette={p} style={{ gap: 12, borderColor: p.amber, borderWidth: 1.5 }}>
          <Text style={{ fontSize: 18, fontWeight: '800', color: p.text }}>
            오늘의 지지선
          </Text>
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Text style={{ fontSize: 20 }}>🚨</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
                  매일 시장 전체를 스캔해요
                </Text>
                <Text style={{ fontSize: 12, color: p.sub, lineHeight: 18, marginTop: 2 }}>
                  국내 거래대금 상위 종목과 미국 S&P500급 종목을 매일 자동으로
                  백테스트합니다. 종목을 하나하나 찾아볼 필요가 없어요.
                </Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Text style={{ fontSize: 20 }}>📍</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
                  오늘 지지선에 닿은 종목만 알려줘요
                </Text>
                <Text style={{ fontSize: 12, color: p.sub, lineHeight: 18, marginTop: 2 }}>
                  3년 백테스트에서 지지 성공률 60% 이상, 반등 3회 이상인 검증된
                  이평선에 오늘 가격이 닿아 있는 종목만 골라줍니다.
                </Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Text style={{ fontSize: 20 }}>💡</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: p.text }}>
                  투자에 이렇게 써보세요
                </Text>
                <Text style={{ fontSize: 12, color: p.sub, lineHeight: 18, marginTop: 2 }}>
                  장 마감 후 확인하면, 오늘 검증된 지지선 근처에서 반등 가능성이
                  있는 종목을 한눈에 볼 수 있어요. 성공률과 차트를 보고 매수
                  타이밍을 판단해 보세요.
                </Text>
              </View>
            </View>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
            <Text style={{ fontSize: 13, color: p.amber, fontWeight: '700' }}>
              오늘의 지지선 보기 →
            </Text>
          </View>
        </Card>
      </TouchableOpacity>

      {/* ── 이평선이란? ── */}
      <Card palette={p} style={{ gap: 8 }}>
        <Text style={{ fontSize: 15, fontWeight: '700', color: p.text }}>
          이동평균선이란?
        </Text>
        <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19 }}>
          이동평균선(MA)은 과거 N일간의 평균 종가를 이은 선입니다.
          주가가 이 선 근처에서 반등하면 "지지", 뚫고 내려가면 "이탈"이라고 해요.
        </Text>
        <Text style={{ fontSize: 12, color: p.sub, lineHeight: 19 }}>
          이 앱은 3년치 데이터를 백테스트해서, 종목마다 실제로 자주 지켜진
          이평선을 자동으로 찾아줍니다. 남들이 많이 쓰는 선이 아닌, 이 종목에
          맞는 선을 알 수 있어요.
        </Text>
      </Card>

      <Footer palette={p} />
    </ScrollView>
  );
}
