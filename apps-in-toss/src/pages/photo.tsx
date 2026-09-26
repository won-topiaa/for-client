import {
  fetchAlbumItems,
  fetchAlbumPhotos,
  FetchAlbumPhotosPermissionError,
  getAnonymousKey,
  openCamera,
  OpenCameraPermissionError,
} from '@apps-in-toss/framework';
import { createRoute } from '@granite-js/react-native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Image,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { analyzePhoto, searchSymbols } from '../api/client';
import type {
  PhotoAnalysisResponse,
  SymbolInfo,
} from '../api/types';
import {
  Card,
  Chip,
  Footer,
  Notice,
  PageHeader,
  PrimaryButton,
  TextButton,
} from '../components/ui';
import { PhotoResult } from '../components/PhotoResult';
import { PushAskSheet } from '../components/PushAskSheet';
import { WaitingShow } from '../components/WaitingShow';
import { isPushAvailable, useMorningPush } from '../notify';
import { LOG } from '../analytics';
import { lastAnalysis, pendingAnalyze } from '../store';
import { GUTTER, RADIUS, usePalette, type Palette } from '../theme';

// 차트 사진 분석 — 사진 업로드 → 분석 → 설명 전달.
//
// 종목은 필수다. 사진만으로 종목을 알아내게 하면 잘린 캡처·비슷한 이름에서
// 엉뚱한 종목을 분석한다. 숫자·판정은 전부 서버가 그 종목의 최신 데이터로
// 계산하고, 사진은 'AI 가 무엇이 보이는지 한두 문장 말하는 데'만 쓴다.
// (서버 app/photo.py · app/diagnosis.py)

export const Route = createRoute('/photo', {
  component: PhotoPage,
});

/** 사진 긴 변을 줄이는 폭. 토스 기본값과 같다 — 차트 모양을 읽기엔 충분하고
 *  AI 입력 토큰(=비용)이 폭에 따라 는다. */
const MAX_WIDTH = 1024;
/** 서버 상한(2.5MB)과 같게 — 보내기 전에 거른다. */
const MAX_BYTES = 2_500_000;

const QUICK_PICKS: SymbolInfo[] = [
  { symbol: '005930', name: '삼성전자', market: 'KOSPI' },
  { symbol: '000660', name: 'SK하이닉스', market: 'KOSPI' },
  { symbol: '005380', name: '현대차', market: 'KOSPI' },
  { symbol: 'NVDA', name: '엔비디아', market: 'NASDAQ' },
  { symbol: 'TSLA', name: '테슬라', market: 'NASDAQ' },
];


type Picked = { base64: string; uri: string };

class PickError extends Error {
  constructor(
    message: string,
    readonly permission?: 'photos' | 'camera'
  ) {
    super(message);
    this.name = 'PickError';
  }
}

function errCode(e: unknown): string {
  return e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '';
}

/** 토스가 돌려준 dataUri(base64 옵션이면 접두어 없는 base64)를 보낼 것·보일 것으로 나눈다. */
function toPicked(dataUri: string | undefined): Picked | null {
  if (!dataUri) {
    return null;
  }
  const base64 = dataUri.startsWith('data:') ? dataUri.slice(dataUri.indexOf(',') + 1) : dataUri;
  if (!base64) {
    return null;
  }
  if ((base64.length * 3) / 4 > MAX_BYTES) {
    throw new PickError('사진이 너무 커요. 차트 부분만 캡처해서 다시 올려 주세요.');
  }
  // 표시용 접두어는 jpeg 로 둔다 — 이미지 디코더는 머리 바이트를 보고 PNG 도 읽는다
  return { base64, uri: dataUri.startsWith('data:') ? dataUri : `data:image/jpeg;base64,${base64}` };
}

/** 앨범에서 한 장 고른다. 취소하면 null. */
async function pickFromAlbum(): Promise<Picked | null> {
  try {
    const items = await fetchAlbumItems({ types: ['PHOTO'], maxCount: 1, maxWidth: MAX_WIDTH, base64: true });
    return toPicked(items[0]?.dataUri);
  } catch (e) {
    if (e instanceof PickError) {
      throw e;
    }
    const code = errCode(e);
    if (code === 'NOT_ALLOWED' || e instanceof FetchAlbumPhotosPermissionError) {
      throw new PickError('사진을 고르려면 사진 접근을 허용해 주세요.', 'photos');
    }
    if (code === 'UNSUPPORTED_APP_VERSION') {
      // 고르는 화면(fetchAlbumItems)은 토스 5.261.0 부터다. 그 아래에서 쓰는
      // fetchAlbumPhotos 는 고르는 화면 없이 사진을 가져올 수 있어, 사용자가
      // 고르지 않은 사진을 보내게 될 수 있다 — 대신 업데이트를 안내한다.
      throw new PickError('토스 앱을 최신 버전으로 업데이트하면 앨범에서 사진을 고를 수 있어요. 카메라로 찍어도 돼요.');
    }
    throw new PickError('사진을 가져오지 못했어요. 다시 시도해 주세요.');
  }
}

/** 카메라로 한 장 찍는다. 취소하면 null. */
async function pickFromCamera(): Promise<Picked | null> {
  try {
    const shot = await openCamera({ base64: true, maxWidth: MAX_WIDTH });
    return toPicked(shot?.dataUri);
  } catch (e) {
    if (e instanceof PickError) {
      throw e;
    }
    if (e instanceof OpenCameraPermissionError) {
      throw new PickError('사진을 찍으려면 카메라 접근을 허용해 주세요.', 'camera');
    }
    // 촬영을 취소해도 예외로 오는 기기가 있다 — 조용히 넘어간다
    return null;
  }
}

/** 지금 권한 상태('allowed'|'denied'|'notDetermined'). 못 읽으면 null. */
async function permissionNow(kind: 'photos' | 'camera'): Promise<string | null> {
  try {
    return kind === 'photos' ? await fetchAlbumPhotos.getPermission() : await openCamera.getPermission();
  } catch {
    return null;
  }
}

/** 권한 다시 묻기. 허용되면 true. */
async function askPermission(kind: 'photos' | 'camera'): Promise<boolean> {
  try {
    const r =
      kind === 'photos'
        ? await fetchAlbumPhotos.openPermissionDialog()
        : await openCamera.openPermissionDialog();
    return r === 'allowed';
  } catch {
    return false;
  }
}

let cachedClientKey: string | undefined;

/** 하루 횟수를 사람 단위로 세기 위한 익명 식별값. 못 받으면 없이 보낸다(서버가 IP 로 센다).
 *  성공만 기억한다 — 한 번 삐끗한 실패를 기억하면 그 세션 내내 통신사 IP 를 나눠 쓰는
 *  다른 사람들과 하루 횟수를 함께 쓰게 된다. */
async function clientKey(): Promise<string | undefined> {
  if (cachedClientKey) {
    return cachedClientKey;
  }
  try {
    const got = await getAnonymousKey();
    if (got && got !== 'ERROR' && typeof got.hash === 'string' && got.hash) {
      cachedClientKey = got.hash;
    }
  } catch {
    // 다음 분석 때 다시 받아 본다
  }
  return cachedClientKey;
}

function StepTitle({ n, title, palette: p }: { n: number; title: string; palette: Palette }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          backgroundColor: p.primaryBg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ fontSize: 12, fontWeight: '700', color: p.primary }}>{n}</Text>
      </View>
      <Text style={{ fontSize: 16, fontWeight: '700', color: p.text }}>{title}</Text>
    </View>
  );
}


function PhotoPage() {
  const p = usePalette();
  const navigation = Route.useNavigation();
  const scrollRef = useRef<ScrollView>(null);
  const resultY = useRef(0);

  // 방금 이평선 분석에서 보던 종목이 있으면 미리 골라 둔다 (바꿀 수 있다)
  const initial = lastAnalysis.value?.info ?? null;
  // 마지막으로 미리 골라 둔 종목 — 이평선 화면에 다녀오면 새 종목으로 바꿔 준다(아래 focus)
  const seeded = useRef(initial?.symbol ?? null);
  const [query, setQuery] = useState(initial ? `${initial.name} (${initial.symbol})` : '');
  const [selected, setSelected] = useState<SymbolInfo | null>(initial);
  const [suggests, setSuggests] = useState<SymbolInfo[]>([]);
  const [photo, setPhoto] = useState<Picked | null>(null);
  const [pickMsg, setPickMsg] = useState<PickError | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [result, setResult] = useState<PhotoAnalysisResponse | null>(null);
  const [viewer, setViewer] = useState(false);
  // 결과 아래 '아침 시장 알림 받기' — 누르면 바텀시트(경쟁 앱 방식). 저절로 띄우지는 않는다:
  // 앱인토스 체크리스트 '화면 전환 시 바텀시트로 행동을 강제 유도하지 않아요'.
  const push = useMorningPush();
  const [askPush, setAskPush] = useState(false);
  // 기다리는 동안 게임에서 새총을 당기는 중이면 스크롤을 잠근다 (안드로이드는 스크롤이 드래그를 빼앗는다)
  const [scrollLock, setScrollLock] = useState(false);

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeq = useRef(0);
  const runSeq = useRef(0);
  // 분석 중에 사진·종목을 바꾸면 도는 요청의 결과는 버린다 — 새 사진 아래에
  // 예전 사진의 설명이 붙으면 안 된다. 기다리는 화면 제목도 보낸 종목 이름으로 고정한다.
  const [runningName, setRunningName] = useState('');
  const loadingRef = useRef(false);
  loadingRef.current = loading;

  const cancelRun = () => {
    runSeq.current++;
    setLoading(false);
  };

  useEffect(
    () => () => {
      if (searchTimer.current) {
        clearTimeout(searchTimer.current);
      }
    },
    []
  );

  // 이 화면은 스택에 남는다 — 사진 → 이평선 분석 → '차트 사진으로 설명 듣기'로 오면
  // 새로 열리지 않고 이 화면으로 되돌아온다. 그 사이 다른 종목을 분석했으면 그 종목으로 바꿔 둔다.
  useEffect(() => {
    const onFocus = () => {
      const info = lastAnalysis.value?.info;
      if (!info || info.symbol === seeded.current || loadingRef.current) {
        return;
      }
      seeded.current = info.symbol;
      searchSeq.current++;
      setSelected(info);
      setQuery(`${info.name} (${info.symbol})`);
      setSuggests([]);
    };
    return navigation.addListener('focus', onFocus);
  }, [navigation]);

  // 켜지면 시트를 닫는다
  useEffect(() => {
    if (push.enabled) {
      setAskPush(false);
    }
  }, [push.enabled]);

  /* ---------- 1. 종목 ---------- */

  const onChangeQuery = (text: string) => {
    searchSeq.current++;
    if (loading) {
      cancelRun();
    }
    setQuery(text);
    setSelected(null);
    if (searchTimer.current) {
      clearTimeout(searchTimer.current);
    }
    const q = text.trim();
    if (!q) {
      setSuggests([]);
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
      if (seq === searchSeq.current) {
        setSuggests(items.slice(0, 8));
      }
    }, 250);
  };

  const pick = (item: SymbolInfo) => {
    searchSeq.current++;
    if (searchTimer.current) {
      clearTimeout(searchTimer.current);
    }
    if (loading && item.symbol !== selected?.symbol) {
      cancelRun();
    }
    setSelected(item);
    setQuery(`${item.name} (${item.symbol})`);
    setSuggests([]);
  };

  /* ---------- 2. 사진 ---------- */

  const choose = useCallback(async (from: 'album' | 'camera', retried = false) => {
    setPickMsg(null);
    const kind = from === 'album' ? 'photos' : 'camera';
    // 처음 묻는 경우(notDetermined)엔 토스가 권한 창을 직접 띄운다 — 거기서 '안하기'를
    // 고른 사람에게 같은 창을 곧바로 또 띄우지 않으려고, 누르기 전 상태를 봐 둔다.
    const before = retried ? null : await permissionNow(kind);
    try {
      const got = from === 'album' ? await pickFromAlbum() : await pickFromCamera();
      if (got) {
        runSeq.current++; // 분석 중이었다면 그 결과는 이전 사진의 것 — 버린다
        setLoading(false);
        setPhoto(got);
        setResult(null);
        setErrorMsg('');
      }
    } catch (e) {
      const err = e instanceof PickError ? e : new PickError('사진을 가져오지 못했어요.');
      // 전에 거부해 둔 권한이면(창 없이 거절됨) 한 번 물어보고, 허용되면 바로 다시 연다
      if (err.permission && !retried && before !== 'notDetermined' && (await askPermission(err.permission))) {
        await choose(from, true);
        return;
      }
      setPickMsg(err);
    }
  }, []);

  /* ---------- 3. 분석 ---------- */

  const run = async () => {
    if (!selected || !photo) {
      return;
    }
    const seq = ++runSeq.current;
    setRunningName(selected.name);
    setLoading(true);
    setErrorMsg('');
    setResult(null);
    try {
      const body = await analyzePhoto({
        symbol: selected.symbol,
        name: selected.name,
        image: photo.base64,
        clientKey: await clientKey(),
      });
      if (seq !== runSeq.current) {
        return;
      }
      setResult(body);
      // 결과가 버튼 아래에 붙는다 — 사용자가 스크롤을 찾지 않게 내려 준다
      // 결과 묶음의 onLayout 이 먼저 돌아야 위치를 안다 — 한 프레임으로는 모자란 기기가 있다
      setTimeout(() => scrollRef.current?.scrollTo({ y: Math.max(0, resultY.current - 12), animated: true }), 250);
    } catch (e) {
      if (seq === runSeq.current) {
        setErrorMsg(e instanceof Error ? e.message : '분석하지 못했어요.');
      }
    } finally {
      if (seq === runSeq.current) {
        setLoading(false);
      }
    }
  };

  const reset = () => {
    runSeq.current++;
    setPhoto(null);
    setResult(null);
    setErrorMsg('');
    setLoading(false);
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  };

  const canRun = !!selected && !!photo && !loading;

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
    <ScrollView
      ref={scrollRef}
      scrollEnabled={!scrollLock}
      style={{ flex: 1, backgroundColor: p.bg }}
      contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: 32, gap: 12 }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <View style={{ flexShrink: 1, paddingRight: 8 }}>
          <PageHeader
            title="차트 사진 분석"
            subtitle="차트 사진을 올리면 그 종목의 지표를 모두 모아 쉽게 설명해 드려요"
            palette={p}
          />
        </View>
        <View style={{ paddingTop: 18 }}>
          <TextButton label="홈" palette={p} onPress={() => navigation.navigate('/')} />
        </View>
      </View>

      {/* ── 1. 종목 (필수) ── */}
      <Card palette={p} style={{ gap: 12 }}>
        <StepTitle n={1} title="어떤 종목의 차트인가요?" palette={p} />
        <TextInput
          value={query}
          onChangeText={onChangeQuery}
          placeholder="종목 이름 · 코드 · 티커 (필수)"
          placeholderTextColor={p.faint}
          autoCorrect={false}
          autoCapitalize="characters"
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
                <Text style={{ fontSize: 15, color: p.text, flexShrink: 1, marginRight: 8 }} numberOfLines={1}>
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
              onPress={() => pick(q)}
            />
          ))}
        </View>
        {selected ? (
          <Text style={{ fontSize: 13, color: p.sub }}>
            선택한 종목: <Text style={{ fontWeight: '700', color: p.text }}>{selected.name}</Text> ({selected.symbol})
          </Text>
        ) : (
          <Text style={{ fontSize: 13, color: p.faint }}>
            검색 결과에서 종목을 눌러 골라 주세요. 사진 속 종목과 같아야 설명이 맞아요.
          </Text>
        )}
      </Card>

      {/* ── 2. 사진 ── */}
      <Card palette={p} style={{ gap: 12 }}>
        <StepTitle n={2} title="차트 사진을 올려 주세요" palette={p} />
        {photo ? (
          <Image
            source={{ uri: photo.uri }}
            resizeMode="contain"
            accessibilityLabel="올린 차트 사진"
            style={{ width: '100%', height: 220, borderRadius: 12, backgroundColor: p.sunken }}
          />
        ) : null}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <PrimaryButton
              label={photo ? '앨범에서 다시' : '앨범에서 고르기'}
              tone="secondary"
              palette={p}
              onPress={() => void choose('album')}
            />
          </View>
          <View style={{ flex: 1 }}>
            <PrimaryButton
              label="카메라로 찍기"
              tone="secondary"
              palette={p}
              onPress={() => void choose('camera')}
            />
          </View>
        </View>
        {pickMsg ? (
          <Notice palette={p} tone="warn">
            {pickMsg.message}
          </Notice>
        ) : null}
        <Text style={{ fontSize: 12.5, color: p.faint, lineHeight: 19 }}>
          증권 앱 차트 화면을 캡처해 올리면 돼요. 잔고·평균 단가가 보이면 가리고 올려 주세요.
          사진은 설명을 만드는 데만 쓰고 저장하지 않아요. 설명을 쓰기 위해 AI 모델
          제공업체(국외)로 전송될 수 있어요. 하루 10번까지 쓸 수 있어요.
        </Text>
      </Card>

      {/* ── 3. 분석 ── */}
      <PrimaryButton
        label={loading ? '분석하는 중…' : '분석하기'}
        disabled={!canRun}
        palette={p}
        logName={LOG.photoAnalyze}
        onPress={() => void run()}
      />
      {!selected && photo ? (
        <Text style={{ fontSize: 13, color: p.warnText }}>종목을 먼저 골라 주세요.</Text>
      ) : null}
      {loading ? (
        <WaitingShow
          palette={p}
          title={`사진과 ${runningName || '종목'}의 최신 데이터를 함께 보고 있어요`}
          subtitle="보통 10~30초"
          onInteract={setScrollLock}
        />
      ) : null}
      {errorMsg ? <Text style={{ fontSize: 14, color: p.danger }}>{errorMsg}</Text> : null}

      {/* ── 결과: 설명 전달 ── */}
      {result ? (
        <View
          onLayout={(e) => {
            resultY.current = e.nativeEvent.layout.y;
          }}
        >
          <PhotoResult
            palette={p}
            result={result}
            photoUri={photo?.uri ?? null}
            onOpenPhoto={() => setViewer(true)}
            onAgain={reset}
            onOpenRadar={() => {
              pendingAnalyze.symbol = result.symbol;
              navigation.navigate('/radar');
            }}
            onAskPush={
              isPushAvailable() && !push.loading && !push.enabled && !push.unsupported
                ? () => setAskPush(true)
                : undefined
            }
          />
        </View>
      ) : null}

      <Footer palette={p} />
    </ScrollView>

      {/* 내가 올린 차트 크게 보기 */}
      {viewer && photo ? (
        <TouchableOpacity
          onPress={() => setViewer(false)}
          accessibilityRole="button"
          accessibilityLabel="크게 보기 닫기"
          activeOpacity={1}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.92)',
            justifyContent: 'center',
            padding: 12,
          }}
        >
          <Image source={{ uri: photo.uri }} resizeMode="contain" style={{ width: '100%', height: '80%' }} />
          <Text style={{ color: '#fff', textAlign: 'center', marginTop: 16, fontSize: 14 }}>눌러서 닫기</Text>
        </TouchableOpacity>
      ) : null}

      {askPush ? (
        <PushAskSheet
          palette={p}
          busy={push.busy}
          problem={push.problem}
          onAgree={push.toggle}
          onLater={() => setAskPush(false)}
        />
      ) : null}
    </View>
  );
}
