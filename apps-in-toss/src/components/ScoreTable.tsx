import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { MAStat } from '../api/types';
import { fmtRate } from '../format';
import type { Palette } from '../theme';

// 전체 후보 이평선 성적표 — 웹(/ma)의 표와 같은 열 구성, 좌우 스크롤

interface Props {
  stats: MAStat[];
  recommended: number[]; // 추천된 period 목록 (★ 표시)
  palette: Palette;
}

// '이탈+돌파' = 위/아래로 뚫린 횟수 합계. 추천 카드는 지지 이탈(하락)을 '이탈',
// 저항 돌파(상승)를 '돌파'로 따로 표기하므로, 그 둘의 합계인 이 열도 '이탈+돌파'로
// 불러 카드와 용어를 맞춘다('돌파' 단독으로 쓰면 카드의 상승 신호와 혼동된다).
const COLS: { key: string; label: string; width: number }[] = [
  { key: 'ma', label: '이평선', width: 76 },
  { key: 'touches', label: '터치', width: 64 },
  { key: 'support', label: '지지', width: 44 },
  { key: 'resist', label: '저항', width: 44 },
  { key: 'breaks', label: '이탈+돌파', width: 68 },
  { key: 'undecided', label: '미확정', width: 52 },
  { key: 'rate', label: '지지성공률', width: 68 },
  { key: 'score', label: '점수', width: 56 },
  { key: 'last', label: '마지막 터치', width: 92 },
];

export function ScoreTable({ stats, recommended, palette: p }: Props) {
  const recoSet = new Set(recommended);
  const rows = [...stats].sort((a, b) => b.score - a.score);

  const cell = (key: string, text: string, width: number, opts?: { bold?: boolean; color?: string }) => (
    <Text
      key={key}
      style={{
        width,
        fontSize: 12,
        paddingVertical: 7,
        paddingHorizontal: 4,
        color: opts?.color ?? p.text,
        fontWeight: opts?.bold ? '700' : '400',
      }}
      numberOfLines={1}
    >
      {text}
    </Text>
  );

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator>
      <View>
        <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: p.border }}>
          {COLS.map((c) => cell(`h-${c.key}`, c.label, c.width, { bold: true, color: p.sub }))}
        </View>
        {rows.map((s) => {
          const isReco = recoSet.has(s.period);
          const dim = !isReco && (s.insufficientData || !s.touches);
          const rate = s.insufficientData ? '—' : fmtRate(s.successRate);
          return (
            <View
              key={s.period}
              style={{
                flexDirection: 'row',
                borderBottomWidth: 1,
                borderBottomColor: p.border,
                backgroundColor: isReco ? p.emeraldBg : undefined,
                opacity: dim ? 0.55 : 1,
              }}
            >
              {cell('ma', `MA ${s.period}${isReco ? ' ★' : ''}`, 76, { bold: isReco })}
              {cell('touches', s.insufficientData ? '데이터 부족' : String(s.touches), 64)}
              {cell('support', String(s.supportBounces), 44)}
              {cell('resist', String(s.resistanceBounces), 44)}
              {cell('breaks', String(s.breaks), 68)}
              {cell('undecided', String(s.undecided), 52)}
              {cell('rate', rate, 68)}
              {cell('score', s.score.toFixed(3), 56)}
              {cell('last', s.lastTouch ?? '—', 92)}
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}
