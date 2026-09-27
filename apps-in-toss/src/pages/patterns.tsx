import { createRoute } from '@granite-js/react-native';
import React from 'react';
import { ScrollView, View } from 'react-native';
import { TabBar, TAB_BAR_SPACER } from '../components/TabBar';
import { Card, Footer, MenuRow, Notice, PageHeader, RowDivider } from '../components/ui';
import { LOG } from '../analytics';
import { GUTTER, usePalette } from '../theme';
import { GROUPS, patternInfo } from '../patternCatalog';

export const Route = createRoute('/patterns', {
  component: PatternsPage,
});

/**
 * 차트 패턴 첫 화면 — 묶음 네 개만 보여 준다.
 *
 * 패턴 14개를 칩으로 한 화면에 늘어놓았더니 '한 공간에 정보가 너무 많아 보기 불편하다'는
 * 의견이 있었다. 묶음(추세선 · 봉우리·골짜기 · 두 선 사이 · 그 밖의 모양)을 누르면 그 묶음의
 * 패턴과 결과만 있는 화면(pages/pattern-group)으로 넘어간다.
 */
function PatternsPage() {
  const p = usePalette();
  const navigation = Route.useNavigation();

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
        {/* 홈·관심종목 이동은 하단 탭바가 맡는다 */}
        <PageHeader
          title="차트 패턴"
          subtitle="지금 이 모양을 만들고 있는 종목을 찾아드려요"
          palette={p}
        />

        <Card palette={p} style={{ padding: 0 }}>
          {GROUPS.map((g, i) => (
            <View key={g.key}>
              {i > 0 ? <RowDivider palette={p} /> : null}
              <MenuRow
                title={g.title}
                // 안에 무엇이 있는지 이름만 — 설명은 넘어간 화면에서
                desc={g.keys.map((k) => patternInfo(k).label).join(' · ')}
                glyph={g.emoji}
                accent={g.accent}
                palette={p}
                onPress={() => navigation.navigate('/pattern-group', { group: g.key })}
                logName={LOG.openFeature}
              />
            </View>
          ))}
        </Card>

        {/* 패턴을 매수신호로 읽지 않게 */}
        <Notice palette={p}>
          패턴은 &apos;지금 이런 모양&apos;이라는 관찰일 뿐이에요. 모양이 나왔다고 그대로
          간다는 보장은 없고, 매수·매도 신호가 아닙니다.
        </Notice>

        <Footer palette={p} />
      </ScrollView>
      <TabBar current="/patterns" palette={p} onNavigate={(to) => navigation.navigate(to)} />
    </View>
  );
}
