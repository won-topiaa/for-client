import { getTossShareLink, share } from '@apps-in-toss/framework';
import React, { useMemo, useState } from 'react';
import { Image, Text, TouchableOpacity, View } from 'react-native';
import type {
  DiagnosisLadder,
  DiagnosisRow,
  DiagnosisSentence,
  PhotoAnalysisResponse,
  PhotoChart,
  PhotoQuota,
  Timeframe,
} from '../api/types';
import type { Palette } from '../theme';
import { LOG, Track } from '../analytics';
import { CandleChart } from './CandleChart';
import { QuotaMeter } from './QuotaMeter';
import { Badge, Card, Chevron, Expandable, Notice, Segmented } from './ui';
import { lh } from '../lineHeight';

// 차트 사진 분석 결과 — 초보자가 위에서부터 읽어 내려가게.
//
//   내가 올린 차트 → 한 줄 요약(1년 범위 막대) → 선을 그린 차트 → (감지된 모양) → 주요 지표 행
//   → 평균선과 지금 주가의 거리 → 자주 묻는 질문 → 자세히 보기(엔진 원문, 중급자용)
//
// 정책 검토(2026-09-26) 뒤 보수적으로: 제목 아래 과거 횟수 줄(경쟁 앱 '반등 가능성' 자리)과
// 아래·위 두 칸(손절가·목표가처럼 읽힘)은 두지 않는다. 과거 기록은 지표 행에, 선은 가격 순 목록으로.
//
// 토론 결론(2026-09-26): 사용자는 '혼합, 초보 쪽으로 기움'. 지표 이름은 남기고(자기
// 증권 앱과 이어 보게) 뜻은 행마다 한 줄 + (?) 도움말로 푼다. 원문과 숫자는 '자세히
// 보기'에 그대로 둔다. 경쟁 앱의 화면 방식(한줄 요약·지표 행·두 칸)은 가져오되,
// 방향·가능성·시나리오 문장은 쓰지 않는다 — 앱인토스 정책 3-6.

const TF_LABEL: Record<Timeframe, string> = { day: '일봉', week: '주봉', month: '월봉' };
const TIMEFRAMES: Timeframe[] = ['day', 'week', 'month'];
const AREA_ORDER = ['지지선', '추세', '모멘텀', '변동성', '거래량', '차트 모양'];

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
      <Text style={{ fontSize: 14.5, color: p.sub, ...lh(22) }}>{row.text}</Text>
      {row.pos != null ? <RangeBar pos={row.pos} span={row.span} palette={p} /> : null}
      {open ? (
        <View style={{ backgroundColor: p.sunken, borderRadius: 10, padding: 12, gap: 4 }}>
          <Text style={{ fontSize: 13.5, color: p.sub, ...lh(20) }}>{row.help}</Text>
          {row.term && row.term !== row.name ? (
            <Text style={{ fontSize: 12.5, color: p.faint }}>증권 앱에서는 이렇게 불러요: {row.term}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** 가격 범위(보통 1년) 안의 위치 — 최저(왼쪽) ~ 최고(오른쪽) 막대 위의 점.
 *  상장한 지 1년이 안 된 종목은 범위도 짧다 — 서버가 준 실제 기간(span)으로 끝 이름을 단다. */
function RangeBar({ pos, span, palette: p }: { pos: number; span?: string; palette: Palette }) {
  const x = Math.max(0, Math.min(1, pos));
  const sp = span || '1년';
  return (
    <View style={{ marginTop: 4, gap: 4 }} accessibilityLabel={`${sp} 가격 범위의 ${Math.round(x * 100)}% 높이`}>
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
        <Text style={{ fontSize: 12, color: p.faint }}>{sp} 최저</Text>
        <Text style={{ fontSize: 12, color: p.faint }}>{sp} 최고</Text>
      </View>
    </View>
  );
}

/** 평균선과 지금 주가의 거리 — 가격 순(높은 것부터)으로 늘어놓고 '지금 주가' 줄을 끼워 넣는다.
 *  아래·위 두 칸은 손절가·목표가로 읽혀서(정책 검토) 한 목록·한 색으로 둔다. */
function Ladder({ ladder, palette: p }: { ladder: DiagnosisLadder; palette: Palette }) {
  const rows: { name: string; text: string; gap: number | null }[] = ladder.items.map((it) => ({
    name: it.name,
    text: it.text,
    gap: it.gapPct,
  }));
  const at = rows.findIndex((r) => (r.gap ?? 0) > 0); // 주가가 선보다 위 = 선이 주가보다 아래
  rows.splice(at < 0 ? rows.length : at, 0, { name: '지금 주가', text: ladder.closeText, gap: null });
  return (
    <View style={{ gap: 0 }}>
      {rows.map((r, i) => {
        const now = r.gap == null;
        return (
          <View
            key={`${r.name}-${i}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingVertical: 10,
              borderTopWidth: i === 0 ? 0 : 1,
              borderTopColor: p.border,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: now ? p.primary : p.muted }} />
              <Text style={{ fontSize: 14.5, fontWeight: now ? '700' : '500', color: now ? p.primary : p.text }}>
                {r.name}
              </Text>
            </View>
            <Text style={{ fontSize: 14, color: now ? p.primary : p.sub, fontWeight: now ? '700' : '400' }}>
              {r.text}
              {now ? '' : ` · 주가가 ${Math.abs(r.gap ?? 0).toFixed(1)}% ${(r.gap ?? 0) >= 0 ? '위' : '아래'}`}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** 선을 그린 차트 — 사진 위가 아니라 앱이 다시 그린, 고른 종목의 최근 일봉 위에.
 *  사진의 가격 눈금을 읽어 그리면 앱마다 몇 %씩 어긋난다('숫자는 사진에서 읽지 않는다').
 *  소개 문장은 실제로 그린 선에 맞춘다 — 모양이 없는데 '모양의 선을 그렸어요'라고 하지 않고,
 *  사진 속 종목이 달라 보일 때도 있으니 '같은 종목' 대신 종목 이름을 쓴다. */
function PhotoChartCard({ chart, who, palette: p }: { chart: PhotoChart; who: string; palette: Palette }) {
  const hasLevel = chart.lines.some((l) => l.kind === 'level');
  const n = chart.candles.length;
  // 사진이 아니라 앱이 다시 그린 차트라는 것만 한 줄로 (어떤 선인지는 아래 범례가 말한다)
  const intro = `${who} · 최근 ${n}거래일 일봉`;
  // 평균선·모양 선은 색을 돌려 쓰고, 가로 가격선은 한 가지 무채색 점선 — 추세선과 섞여 보이지 않게
  const colors = [p.primary, p.ma[1] ?? p.warn, p.ma[2] ?? p.sub, p.ma[3] ?? p.faint];
  let ci = 0;
  const styled = chart.lines.map((ln) =>
    ln.kind === 'level'
      ? { ...ln, color: p.sub, width: 1.5, dashed: true }
      : { ...ln, color: colors[ci++ % colors.length] ?? p.primary, width: ln.kind === 'ma' ? 2 : 1.5, dashed: false }
  );
  const lines = styled.map((ln) => ({ color: ln.color, points: ln.points, width: ln.width, dashed: ln.dashed }));
  return (
    <Card palette={p} style={{ gap: 12 }}>
      <BarTitle title="선을 그린 차트" palette={p} />
      <Text style={{ fontSize: 13, color: p.faint }}>{intro}</Text>
      <CandleChart
        candles={chart.candles}
        lines={lines}
        height={200}
        // 서버가 모양의 첫 점까지 창을 넓혀 보낸다(최대 200봉) — 받은 봉을 모두 그린다
        maxBars={Math.max(1, chart.candles.length)}
        colors={{ up: p.up, down: p.down, grid: p.grid, text: p.faint }}
      />
      {chart.lines.length > 0 ? (
        <View style={{ gap: 6 }}>
          {styled.map((ln, i) => (
            <View key={`${ln.name}-${i}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {ln.dashed ? (
                <View style={{ width: 16, flexDirection: 'row', justifyContent: 'space-between' }}>
                  {[0, 1, 2].map((k) => (
                    <View key={k} style={{ width: 4, height: 2, borderRadius: 1, backgroundColor: ln.color }} />
                  ))}
                </View>
              ) : (
                <View style={{ width: 16, height: 3, borderRadius: 2, backgroundColor: ln.color }} />
              )}
              <Text style={{ fontSize: 13, color: p.sub, flexShrink: 1 }}>{ln.name}</Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={{ fontSize: 13, color: p.faint }}>이 종목에는 겹쳐 그릴 선이 없어 캔들만 그렸어요.</Text>
      )}
      {hasLevel ? (
        // 지난 사실만 — '지지선/저항선'이라 이름 붙이지 않는다(지금 가격 아래·위의 이름 붙은 선은
        // 손절가·목표가로 읽힌다).
        <Text style={{ fontSize: 12.5, color: p.faint, ...lh(18) }}>
          가로 점선: 최근 1년 주가가 여러 번 방향을 바꾼 가격. 다음에도 그 가격에서 멈춘다는 뜻은 아니에요.
        </Text>
      ) : null}
    </Card>
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

/** 공유 — 엔진이 계산한 한 줄 요약(1년 범위 높이)만. 모양 이름·과거 횟수는 넣지 않는다:
 *  앱 밖 제3자에게는 풀이 없이 종목 신호처럼 퍼진다(정책 검토). 📈 대신 📊. 계좌·사진은 보내지 않는다. */
async function shareResult(result: PhotoAnalysisResponse, headline: string): Promise<void> {
  const who = result.name || result.symbol;
  let link = '';
  try {
    link = await getTossShareLink('intoss://wontopia-ma-radar/photo');
  } catch {
    link = ''; // 오래된 토스 앱 — 링크 없이 글만 보낸다
  }
  const message = [
    `📊 ${who} 차트 사진 풀이`,
    headline,
    `이평선 레이더가 ${result.asOf} 종가까지의 지난 가격으로 계산한 숫자예요. 앞으로의 움직임은 알려 주지 않고, 투자 권유가 아니에요.`,
    link,
  ]
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
  quota,
}: {
  palette: Palette;
  result: PhotoAnalysisResponse;
  photoUri: string | null;
  onOpenPhoto: () => void;
  onAgain: () => void;
  onOpenRadar: () => void;
  /** 아침 알림을 안 받는 사람에게만 — 누르면 바텀시트를 연다 */
  onAskPush?: () => void;
  /** 오늘 남은 분석 횟수 — '다른 차트도 분석하기' 바로 위에 한 줄로 */
  quota?: PhotoQuota | null;
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
  // 제목은 엔진이 계산한 문장을 먼저(공유로도 나간다) — 서버도 같은 순서로 정한다
  const headline = diag.headline || ex.headline || `${who}의 지표를 모아 봤어요.`;
  const ladder = diag.ladder ?? null;
  const dayRows = diag.timeframes.day?.rows ?? [];
  const yearRow = dayRows.find((r) => r.key === 'yearRange');
  const yearPos = yearRow?.pos ?? null;
  const yearSpan = yearRow?.span;
  const chips = useMemo(() => {
    const by = new Map(dayRows.map((r) => [r.key, r]));
    const out: string[] = [];
    // 제목의 숫자(1년 범위 높이)는 칩에 되풀이하지 않는다
    const atr = by.get('atr');
    if (atr) out.push(`하루 움직임 ${atr.value}`);
    const vol = by.get('volume');
    if (vol) out.push(`거래량 ${vol.value}`);
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
          <Text style={{ fontSize: 13, fontWeight: '700', color: p.primary }}>한 줄 요약</Text>
          {/* 제목·지표는 엔진 계산, AI 는 요약·사진 설명만 — 배지가 전부 AI 판단처럼 보이지 않게 */}
          <Badge label={byAi ? 'AI 요약 포함' : '기본 설명'} tone={byAi ? 'primary' : 'plain'} palette={p} />
        </View>
        <Text accessibilityRole="header" style={{ fontSize: 22, fontWeight: '800', color: p.text, ...lh(31) }}>
          {headline}
        </Text>
        {yearPos != null ? <RangeBar pos={yearPos} span={yearSpan} palette={p} /> : null}
        {/* 한눈에 — 숫자 사실 칩 (경쟁 앱의 '감지된 패턴 75%' 칩 자리) */}
        {chips.length > 0 ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {chips.map((c) => (
              <View key={c} style={{ backgroundColor: p.sunken, borderRadius: 10, paddingVertical: 6, paddingHorizontal: 10 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: p.sub }}>{c}</Text>
              </View>
            ))}
          </View>
        ) : null}
        <Text style={{ fontSize: 15, color: p.sub, ...lh(24) }}>{ex.summary}</Text>
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
            사진 속 종목이 고르신 종목과 달라 보여요. 위 내용은 {who} 기준이에요.
          </Notice>
        ) : null}
        {ex.timeframe === 'intraday' ? (
          <Notice palette={p}>사진은 분·시간 단위 차트로 보여요. 이 앱은 일봉·주봉·월봉으로 계산해요.</Notice>
        ) : null}
        <View style={{ backgroundColor: p.sunken, borderRadius: 12, padding: 12, gap: 4 }}>
          <Text style={{ fontSize: 12.5, fontWeight: '700', color: p.faint }}>
            {byAi ? '사진에서 보이는 것' : '안내'}
          </Text>
          <Text style={{ fontSize: 14, color: p.sub, ...lh(21) }}>{ex.photoNote}</Text>
        </View>
      </Card>

      {result.chart ? <PhotoChartCard chart={result.chart} who={who} palette={p} /> : null}

      {/* 감지된 차트 모양 — 보일 때만 (일봉 기준) */}
      {diag.patterns.length > 0 ? (
        <Card palette={p} style={{ gap: 14 }}>
          <BarTitle title="감지된 차트 모양" palette={p} />
          {diag.patterns.map((pt) => (
            <View key={pt.key} style={{ gap: 6 }}>
              <Text style={{ fontSize: 19, fontWeight: '800', color: p.text }}>{pt.name}</Text>
              {pt.help ? <Text style={{ fontSize: 14.5, color: p.sub, ...lh(22) }}>{pt.help}</Text> : null}
              {pt.note ? (
                <View style={{ backgroundColor: p.sunken, borderRadius: 10, padding: 10 }}>
                  <Text style={{ fontSize: 13.5, color: p.sub, ...lh(20) }}>{pt.note}</Text>
                </View>
              ) : null}
              {pt.facts.map((f, i) => (
                <Text key={i} style={{ fontSize: 14, color: p.sub, ...lh(21) }}>
                  · {f}
                </Text>
              ))}
            </View>
          ))}
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
        </Card>
      ) : null}

      {/* 평균선과 지금 주가의 거리 — '앞으로 어떻게 될까' 대신 사실만, 아래·위 두 칸 없이 */}
      {ladder && ladder.items.length > 0 ? (
        <Card palette={p} style={{ gap: 10 }}>
          <BarTitle title="평균선과 지금 주가의 거리" palette={p} />
          <Ladder ladder={ladder} palette={p} />
          <Text style={{ fontSize: 12.5, color: p.faint, ...lh(18) }}>
            {result.asOf} 종가 기준
          </Text>
        </Card>
      ) : null}


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
                    <Text style={{ fontSize: 14.5, color: p.text, ...lh(22) }}>{s.text}</Text>
                  </View>
                ))}
              </View>
            ))
          )}
        </View>
      </Expandable>

      <Notice palette={p}>{result.notice}</Notice>

      {/* 다음 행동 — 오늘 남은 횟수를 바로 위에 */}
      {quota ? <QuotaMeter quota={quota} palette={p} compact /> : null}
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
            <Text style={{ fontSize: 13, color: p.sub, marginTop: 2 }}>화~토 아침, 전날 미국 시장을 한 줄로 보내 드려요</Text>
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
