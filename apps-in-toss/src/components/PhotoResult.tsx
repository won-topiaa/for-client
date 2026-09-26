import { getTossShareLink, share } from '@apps-in-toss/framework';
import React, { useMemo, useState } from 'react';
import { Image, Text, TouchableOpacity, View } from 'react-native';
import type {
  DiagnosisLevel,
  DiagnosisRow,
  DiagnosisSentence,
  PhotoAnalysisResponse,
  Timeframe,
} from '../api/types';
import type { Palette } from '../theme';
import { LOG, Track } from '../analytics';
import { Badge, Card, Chevron, Expandable, Notice, Segmented } from './ui';

// 차트 사진 분석 결과 — 초보자가 위에서부터 읽어 내려가게.
//
//   내가 올린 차트 → 한줄 요약 → (감지된 모양) → 주요 지표 행 → 지금 가까운 선
//   → 자주 묻는 질문 → 자세히 보기(엔진 원문, 중급자용)
//
// 토론 결론(2026-09-26): 사용자는 '혼합, 초보 쪽으로 기움'. 지표 이름은 남기고(자기
// 증권 앱과 이어 보게) 뜻은 행마다 한 줄 + (?) 도움말로 푼다. 원문과 숫자는 '자세히
// 보기'에 그대로 둔다. 경쟁 앱의 화면 방식(한줄 요약·지표 행·두 칸)은 가져오되,
// 방향·가능성·시나리오 문장은 쓰지 않는다 — 앱인토스 정책 3-6.

const TF_LABEL: Record<Timeframe, string> = { day: '일봉', week: '주봉', month: '월봉' };
const TIMEFRAMES: Timeframe[] = ['day', 'week', 'month'];
const AREA_ORDER = ['지지선', '추세', '모멘텀', '변동성', '거래량', '차트 모양'];

/** 결과 화면 공통 질문 — 광고로 잠그지 않는다(답이 곧 오해를 막는 안내라서). */
const FAQ: { q: string; a: string }[] = [
  {
    q: '지표가 대부분 ‘위’면 좋은 건가요?',
    a: '지표는 지금 가격이 과거와 비교해 어디쯤 있는지를 보여 줄 뿐이에요. 좋다·나쁘다나 앞으로의 방향을 알려 주지는 않아요. 같은 상태에서도 과거에는 오른 때와 내린 때가 모두 있었어요.',
  },
  {
    q: '‘가장 잘 지켜진 선’은 어떻게 고른 거예요?',
    a: '이 앱이 지난 기록을 뒤져, 주가가 평균선까지 내려왔다가 다시 올라간 일이 가장 많았던 선을 골라요. 몇 번 중 몇 번이었는지도 함께 보여 드려요. 지난 기록일 뿐, 앞으로 그렇게 될 확률은 아니에요.',
  },
  {
    q: '사진 속 숫자와 조금 달라요.',
    a: '숫자는 사진에서 읽지 않고, 그 종목의 최신 종가 데이터로 다시 계산해요. 사진을 찍은 시점이나 증권 앱 설정(평균선 기간 등)에 따라 조금 다를 수 있어요.',
  },
];

const PATTERN_FAQ = {
  q: '이 모양이 나오면 보통 어떻게 됐어요?',
  a: '이 앱은 차트가 교과서 속 모양과 맞는지까지만 알려 드려요. 같은 모양이라도 그 뒤의 움직임은 종목과 시기마다 달라서, 방향은 말씀드리지 않아요.',
};

/** 파란 세로 막대 + 제목 — 카드 안의 섹션 머리. */
function BarTitle({ title, palette: p, right }: { title: string; palette: Palette; right?: React.ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
        <View style={{ width: 4, height: 18, borderRadius: 2, backgroundColor: p.primary }} />
        <Text accessibilityRole="header" style={{ fontSize: 17, fontWeight: '700', color: p.text }}>
          {title}
        </Text>
      </View>
      {right}
    </View>
  );
}

/** (?) 동그라미 — 눌러서 도움말을 펼친다. */
function HelpDot({ open, palette: p, onPress, label }: { open: boolean; palette: Palette; onPress: () => void; label: string }) {
  return (
    <Track name={LOG.photoHelp} text={label} enabled={!open}>
      <TouchableOpacity
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${label} 뜻 ${open ? '접기' : '보기'}`}
        accessibilityState={{ expanded: open }}
        hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
        activeOpacity={0.6}
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          borderWidth: 1.5,
          borderColor: open ? p.primary : p.muted,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ fontSize: 11.5, fontWeight: '700', color: open ? p.primary : p.faint }}>?</Text>
      </TouchableOpacity>
    </Track>
  );
}

/** 질문 행 — 누르면 답이 펼쳐진다. */
function QaRow({ q, a, palette: p }: { q: string; a: string; palette: Palette }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: p.border, borderStyle: 'dashed', paddingTop: 14, gap: 8 }}>
      <Track name={LOG.photoFaq} text={q} enabled={!open}>
        <TouchableOpacity
          onPress={() => setOpen(!open)}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          activeOpacity={0.6}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
        >
          <View
            style={{
              width: 26,
              height: 26,
              borderRadius: 13,
              backgroundColor: p.primaryBg,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: '800', color: p.primary }}>?</Text>
          </View>
          <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: p.text, lineHeight: 21 }}>{q}</Text>
          <Chevron dir={open ? 'up' : 'down'} color={p.faint} size={8} />
        </TouchableOpacity>
      </Track>
      {open ? (
        <Text style={{ fontSize: 14, color: p.sub, lineHeight: 21, paddingLeft: 36 }}>{a}</Text>
      ) : null}
    </View>
  );
}

/** 주요 지표 한 행 — 이름 (?) ··· 지금 상태 / 한 줄 풀이 / (펼치면) 뜻. */
function IndicatorRow({ row, palette: p, first }: { row: DiagnosisRow; palette: Palette; first: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 6, paddingTop: first ? 0 : 16, borderTopWidth: first ? 0 : 1, borderTopColor: p.border }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: p.text, flexShrink: 1 }}>{row.name}</Text>
          <HelpDot open={open} palette={p} onPress={() => setOpen(!open)} label={row.name} />
        </View>
        {/* 상태 값은 한 가지 색 — 초록/빨강을 칠하면 좋다·나쁘다로 읽힌다 */}
        <Text style={{ fontSize: 15, fontWeight: '700', color: p.primary, flexShrink: 0 }}>{row.value}</Text>
      </View>
      <Text style={{ fontSize: 14.5, color: p.sub, lineHeight: 22 }}>{row.text}</Text>
      {row.pos != null ? <RangeBar pos={row.pos} palette={p} /> : null}
      {open ? (
        <View style={{ backgroundColor: p.sunken, borderRadius: 10, padding: 12, gap: 4 }}>
          <Text style={{ fontSize: 13.5, color: p.sub, lineHeight: 20 }}>{row.help}</Text>
          {row.term && row.term !== row.name ? (
            <Text style={{ fontSize: 12.5, color: p.faint }}>증권 앱에서는 이렇게 불러요: {row.term}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** 1년 범위 안의 위치 — 최저(왼쪽) ~ 최고(오른쪽) 막대 위의 점. */
function RangeBar({ pos, palette: p }: { pos: number; palette: Palette }) {
  const x = Math.max(0, Math.min(1, pos));
  return (
    <View style={{ marginTop: 4, gap: 4 }} accessibilityLabel={`1년 범위의 ${Math.round(x * 100)}% 높이`}>
      <View style={{ height: 14, justifyContent: 'center' }}>
        <View style={{ height: 4, borderRadius: 2, backgroundColor: p.sunken }} />
        <View
          style={{
            position: 'absolute',
            left: `${x * 100}%`,
            marginLeft: -7,
            width: 14,
            height: 14,
            borderRadius: 7,
            backgroundColor: p.primary,
            borderWidth: 2,
            borderColor: p.card,
          }}
        />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ fontSize: 12, color: p.faint }}>1년 최저</Text>
        <Text style={{ fontSize: 12, color: p.faint }}>1년 최고</Text>
      </View>
    </View>
  );
}

/** 지금 가까운 선 한 칸 — 방향 색(빨강/초록)을 쓰지 않는다. */
function LevelTile({ title, level, palette: p }: { title: string; level: DiagnosisLevel | null; palette: Palette }) {
  return (
    <View style={{ flex: 1, backgroundColor: p.sunken, borderRadius: 14, padding: 14, gap: 6 }}>
      <Text style={{ fontSize: 13, fontWeight: '700', color: p.faint }}>{title}</Text>
      {level ? (
        <>
          <Text style={{ fontSize: 17, fontWeight: '700', color: p.text }}>{level.text}</Text>
          <Text style={{ fontSize: 13.5, color: p.sub, lineHeight: 19 }}>{level.name}</Text>
          {/* 주가 기준으로 말한다 — '지금보다 3% 위'는 목표가처럼 읽힌다 */}
          <Text style={{ fontSize: 13, color: p.sub, lineHeight: 19 }}>
            주가가 이 선보다 {Math.abs(level.gapPct).toFixed(1)}% {level.gapPct >= 0 ? '위' : '아래'}에 있어요
          </Text>
          {level.note ? <Text style={{ fontSize: 12.5, color: p.faint, lineHeight: 18 }}>{level.note}</Text> : null}
        </>
      ) : (
        <Text style={{ fontSize: 13.5, color: p.sub, lineHeight: 19 }}>이쪽에는 가까운 선이 없어요</Text>
      )}
    </View>
  );
}

function groupByArea(sentences: DiagnosisSentence[]): [string, DiagnosisSentence[]][] {
  const groups = new Map<string, DiagnosisSentence[]>();
  for (const s of sentences) {
    groups.set(s.area, [...(groups.get(s.area) ?? []), s]);
  }
  const rank = (a: string) => {
    const i = AREA_ORDER.indexOf(a);
    return i < 0 ? AREA_ORDER.length : i;
  };
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
}

/** 공유 — 한줄 요약만 담는다. 계좌·사진은 보내지 않는다. */
async function shareResult(result: PhotoAnalysisResponse, headline: string): Promise<void> {
  const who = result.name || result.symbol;
  let link = '';
  try {
    link = await getTossShareLink('intoss://wontopia-ma-radar/photo');
  } catch {
    link = ''; // 오래된 토스 앱 — 링크 없이 글만 보낸다
  }
  const message = [`📈 ${who} 차트 사진 분석`, headline, `(${result.asOf} 종가 기준 · 투자 권유가 아니에요)`, link]
    .filter(Boolean)
    .join('\n');
  await share({ message });
}

export function PhotoResult({
  palette: p,
  result,
  photoUri,
  onOpenPhoto,
  onAgain,
  onOpenRadar,
  onAskPush,
}: {
  palette: Palette;
  result: PhotoAnalysisResponse;
  photoUri: string | null;
  onOpenPhoto: () => void;
  onAgain: () => void;
  onOpenRadar: () => void;
  /** 아침 알림을 안 받는 사람에게만 — 누르면 바텀시트를 연다 */
  onAskPush?: () => void;
}) {
  const ex = result.explanation;
  const diag = result.diagnosis;
  const byAi = ex.by !== 'template';
  const who = result.name || result.symbol;
  const shownTf: Timeframe = ex.timeframe === 'week' || ex.timeframe === 'month' ? ex.timeframe : 'day';
  const [tf, setTf] = useState<Timeframe>(shownTf);
  const [detailTf, setDetailTf] = useState<Timeframe>(shownTf);
  const [shareFailed, setShareFailed] = useState(false);
  const rows = diag.timeframes[tf]?.rows ?? [];
  const sentences = diag.timeframes[detailTf]?.sentences ?? [];
  const headline = ex.headline || diag.headline || `${who}의 지표를 모아 봤어요.`;
  const levels = diag.levels ?? null;
  const dayRows = diag.timeframes.day?.rows ?? [];
  const chips = useMemo(() => {
    const by = new Map(dayRows.map((r) => [r.key, r]));
    const out: string[] = [];
    const yr = by.get('yearRange');
    if (yr) out.push(`1년 범위 ${yr.value}`);
    const sup = by.get('support');
    if (sup) out.push(`잘 지켜진 선보다 ${sup.value}`);
    const atr = by.get('atr');
    if (atr) out.push(`하루 움직임 ${atr.value}`);
    if (diag.patterns.length > 0) out.push(`${diag.patterns[0]?.name ?? ''} 모양`);
    return out;
  }, [dayRows, diag.patterns]);
  const tfOptions = useMemo(
    () => TIMEFRAMES.filter((t) => (diag.timeframes[t]?.rows ?? []).length > 0).map((t) => ({ value: t, label: TF_LABEL[t] })),
    [diag]
  );

  return (
    <View style={{ gap: 12 }}>
      {/* 내가 올린 차트 */}
      {photoUri ? (
        <TouchableOpacity
          onPress={onOpenPhoto}
          accessibilityRole="button"
          accessibilityLabel="내가 올린 차트 크게 보기"
          activeOpacity={0.7}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 14,
            backgroundColor: p.card,
            borderRadius: 16,
            padding: 12,
          }}
        >
          <Image
            source={{ uri: photoUri }}
            resizeMode="cover"
            style={{ width: 72, height: 48, borderRadius: 8, backgroundColor: p.sunken }}
          />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: p.text }}>내가 올린 차트</Text>
            <Text style={{ fontSize: 13, color: p.faint, marginTop: 2 }}>탭해서 크게 보기</Text>
          </View>
          <Chevron dir="right" color={p.faint} size={9} />
        </TouchableOpacity>
      ) : null}

      {/* 한줄 요약 */}
      <Card palette={p} style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: p.primary }}>한줄 요약</Text>
          <Badge label={byAi ? 'AI 설명' : '기본 설명'} tone={byAi ? 'primary' : 'plain'} palette={p} />
        </View>
        <Text accessibilityRole="header" style={{ fontSize: 22, fontWeight: '800', color: p.text, lineHeight: 31 }}>
          {headline}
        </Text>
        {/* 한눈에 — '지금 어디쯤인지'를 숫자 사실로 (경쟁 앱의 '감지된 패턴 75%' 칩 자리) */}
        {chips.length > 0 ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {chips.map((c) => (
              <View key={c} style={{ backgroundColor: p.sunken, borderRadius: 10, paddingVertical: 6, paddingHorizontal: 10 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: p.sub }}>{c}</Text>
              </View>
            ))}
          </View>
        ) : null}
        <Text style={{ fontSize: 15, color: p.sub, lineHeight: 24 }}>{ex.summary}</Text>
        <Text style={{ fontSize: 12.5, color: p.faint }}>
          {who} · {result.symbol} · {result.asOf} 종가 기준
        </Text>
        {ex.isChart === false ? (
          <Notice palette={p} tone="warn">
            주가 차트 사진이 아닌 것 같아요. 위 내용은 사진이 아니라 {who}의 최신 데이터로 계산한 거예요.
          </Notice>
        ) : null}
        {ex.sameStock === 'no' ? (
          <Notice palette={p} tone="warn">
            사진 속 종목이 {who}와(과) 달라 보여요. 위 내용은 고르신 {who} 기준이에요.
          </Notice>
        ) : null}
        {ex.timeframe === 'intraday' ? (
          <Notice palette={p}>사진은 분·시간 단위 차트로 보여요. 이 앱은 일봉·주봉·월봉으로 계산해요.</Notice>
        ) : null}
        <View style={{ backgroundColor: p.sunken, borderRadius: 12, padding: 12, gap: 4 }}>
          <Text style={{ fontSize: 12.5, fontWeight: '700', color: p.faint }}>
            {byAi ? '사진에서 보이는 것' : '안내'}
          </Text>
          <Text style={{ fontSize: 14, color: p.sub, lineHeight: 21 }}>{ex.photoNote}</Text>
        </View>
      </Card>

      {/* 감지된 차트 모양 — 보일 때만 (일봉 기준) */}
      {diag.patterns.length > 0 ? (
        <Card palette={p} style={{ gap: 14 }}>
          <BarTitle title="감지된 차트 모양" palette={p} />
          {diag.patterns.map((pt) => (
            <View key={pt.key} style={{ gap: 6 }}>
              <Text style={{ fontSize: 19, fontWeight: '800', color: p.text }}>{pt.name}</Text>
              {pt.help ? <Text style={{ fontSize: 14.5, color: p.sub, lineHeight: 22 }}>{pt.help}</Text> : null}
              {pt.facts.map((f, i) => (
                <Text key={i} style={{ fontSize: 14, color: p.sub, lineHeight: 21 }}>
                  · {f}
                </Text>
              ))}
            </View>
          ))}
          <QaRow q={PATTERN_FAQ.q} a={PATTERN_FAQ.a} palette={p} />
        </Card>
      ) : null}

      {/* 주요 지표 */}
      {rows.length > 0 ? (
        <Card palette={p} style={{ gap: 14 }}>
          <BarTitle title="주요 지표" palette={p} />
          {tfOptions.length > 1 ? (
            <Segmented options={tfOptions} value={tf} palette={p} onChange={setTf} />
          ) : null}
          {rows.map((r, i) => (
            <IndicatorRow key={`${tf}-${r.key}`} row={r} palette={p} first={i === 0} />
          ))}
          <Text style={{ fontSize: 12.5, color: p.faint, lineHeight: 18 }}>
            (?)를 누르면 그 지표가 무엇을 재는지 알려 드려요. 지표는 지금 상태를 보여 줄 뿐, 좋다·나쁘다를 뜻하지 않아요.
          </Text>
        </Card>
      ) : null}

      {/* 지금 가까운 선 — '앞으로 어떻게 될까' 대신 사실만 */}
      {levels && (levels.below || levels.above) ? (
        <Card palette={p} style={{ gap: 14 }}>
          <BarTitle title="지금 가격 주변의 선" palette={p} />
          <Text style={{ fontSize: 14, color: p.sub, lineHeight: 21 }}>
            지금 주가({levels.closeText}) 바로 아래와 바로 위에 있는 선이에요.
          </Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <LevelTile title="아래쪽 가까운 선" level={levels.below} palette={p} />
            <LevelTile title="위쪽 가까운 선" level={levels.above} palette={p} />
          </View>
          <Text style={{ fontSize: 12.5, color: p.faint, lineHeight: 18 }}>
            과거에 자주 지켜진 선이라도 앞으로도 그렇다는 뜻은 아니에요.
          </Text>
        </Card>
      ) : null}

      {/* 자주 묻는 질문 */}
      <Card palette={p} style={{ gap: 14 }}>
        <BarTitle title="자주 묻는 질문" palette={p} />
        {FAQ.map((f) => (
          <QaRow key={f.q} q={f.q} a={f.a} palette={p} />
        ))}
      </Card>

      {/* 자세히 보기 — 엔진 원문(숫자 그대로). 지표를 아는 사람용 */}
      <Expandable title="자세히 보기 · 지표 원문" palette={p} logName={LOG.photoDetail}>
        <View style={{ gap: 14 }}>
          <Segmented
            options={TIMEFRAMES.map((t) => ({ value: t, label: TF_LABEL[t] }))}
            value={detailTf}
            palette={p}
            onChange={setDetailTf}
          />
          {sentences.length === 0 ? (
            <Text style={{ fontSize: 14, color: p.sub }}>{TF_LABEL[detailTf]} 데이터가 모자라 계산하지 못했어요.</Text>
          ) : (
            groupByArea(sentences).map(([area, list]) => (
              <View key={area} style={{ gap: 8 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: p.primary }}>{area}</Text>
                {list.map((s, i) => (
                  <View key={`${s.label}-${i}`} style={{ gap: 2 }}>
                    <Text style={{ fontSize: 13, color: p.sub }}>{s.label}</Text>
                    <Text style={{ fontSize: 14.5, color: p.text, lineHeight: 22 }}>{s.text}</Text>
                  </View>
                ))}
              </View>
            ))
          )}
        </View>
      </Expandable>

      <Notice palette={p}>{result.notice}</Notice>

      {/* 다음 행동 */}
      <Track name={LOG.photoAgain}>
        <TouchableOpacity
          onPress={onAgain}
          accessibilityRole="button"
          activeOpacity={0.8}
          style={{ backgroundColor: p.primaryFill, borderRadius: 16, paddingVertical: 16, alignItems: 'center' }}
        >
          <Text style={{ fontSize: 16, fontWeight: '700', color: p.onPrimary }}>다른 차트도 분석하기</Text>
        </TouchableOpacity>
      </Track>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Track name={LOG.photoShare}>
          <TouchableOpacity
            onPress={() => {
              setShareFailed(false);
              shareResult(result, headline).catch(() => setShareFailed(true));
            }}
            accessibilityRole="button"
            activeOpacity={0.7}
            style={{ flex: 1, backgroundColor: p.card, borderRadius: 16, paddingVertical: 14, alignItems: 'center' }}
          >
            <Text style={{ fontSize: 15, fontWeight: '600', color: p.text }}>친구에게 공유하기</Text>
          </TouchableOpacity>
        </Track>
        <TouchableOpacity
          onPress={onOpenRadar}
          accessibilityRole="button"
          activeOpacity={0.7}
          style={{ flex: 1, backgroundColor: p.card, borderRadius: 16, paddingVertical: 14, alignItems: 'center' }}
        >
          <Text style={{ fontSize: 15, fontWeight: '600', color: p.text }}>이평선 분석 보기</Text>
        </TouchableOpacity>
      </View>
      {onAskPush ? (
        <TouchableOpacity
          onPress={onAskPush}
          accessibilityRole="button"
          activeOpacity={0.7}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: p.card, borderRadius: 16, padding: 16 }}
        >
          <Text style={{ fontSize: 22 }}>🔔</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: p.text }}>아침 시장 알림 받기</Text>
            <Text style={{ fontSize: 13, color: p.sub, marginTop: 2 }}>전날 미국 시장을 아침에 한 줄로 챙겨 드려요</Text>
          </View>
          <Chevron dir="right" color={p.faint} size={9} />
        </TouchableOpacity>
      ) : null}
      {shareFailed ? (
        <Text style={{ fontSize: 13, color: p.faint, textAlign: 'center' }}>공유 창을 열지 못했어요.</Text>
      ) : null}
    </View>
  );
}
