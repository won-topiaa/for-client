import { createRoute } from '@granite-js/react-native';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { fetchBrief, type BriefResponse } from '../api/client';
import { Card, Footer, Notice, PageHeader, PrimaryButton, TextButton } from '../components/ui';
import { LOG } from '../analytics';
import { PUSH_TIME_LABEL } from '../env';
import { isPushAvailable, useMorningPush } from '../notify';
import {
  forgetWatchAlert,
  reconcileWatchAlert,
  useWatchAlert,
  watchedForAlert,
  WATCH_ALERT_MAX,
} from '../watchAlert';
import { useWatchlist } from '../watchlist';
import { GUTTER, usePalette } from '../theme';

export const Route = createRoute('/notify', {
  component: NotifyPage,
});

function NotifyPage() {
  const p = usePalette();
  const navigation = Route.useNavigation();
  const push = useMorningPush();
  const watchAlert = useWatchAlert();
  // ready 를 함께 본다 — 저장소를 읽기 전 items 는 빈 배열이라,
  // 종목을 담아 둔 사람에게도 '먼저 관심종목을 담아 주세요'가 잠깐 스친다.
  const { items: watched, ready: watchedReady } = useWatchlist();
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchProblem, setWatchProblem] = useState<string | null>(null);
  const [brief, setBrief] = useState<BriefResponse | null>(null);
  const [briefFailed, setBriefFailed] = useState(false);

  // 기기 저장소가 비었어도(앱 재설치 등) 서버에 종목이 남아 있으면 알림은
  // 계속 간다 — 그때 화면이 '꺼짐'이면 끌 방법이 없다. 서버를 따른다.
  useEffect(() => {
    reconcileWatchAlert(push.watchCount);
  }, [push.watchCount]);

  // 아침 알림을 끄면 관심종목 알림도 설 자리가 없다 (서버도 함께 지운다).
  // loading 중에는 판단하지 않는다 — 상태를 받기 전 enabled 는 그냥 false 다.
  useEffect(() => {
    if (!push.loading && !push.enabled) {
      forgetWatchAlert();
    }
  }, [push.loading, push.enabled]);

  // 미리보기는 실제 발송 문구를 그대로 만들어 보여 준다 — '무엇이 오는지' 를
  // 말로 설명하는 것보다 한 줄 보여 주는 편이 정확하다.
  useEffect(() => {
    let alive = true;
    fetchBrief()
      .then((res) => {
        if (alive) {
          setBrief(res);
        }
      })
      .catch(() => {
        if (alive) {
          setBriefFailed(true);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const available = isPushAvailable();

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: p.bg }}
      contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: 24, gap: 12 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <View style={{ flexShrink: 1, paddingRight: 8 }}>
          <PageHeader
            title="아침 시장 알림"
            subtitle={`${PUSH_TIME_LABEL}에 한 줄로 받아요`}
            palette={p}
          />
        </View>
        <View style={{ paddingTop: 18 }}>
          <TextButton label="홈" palette={p} onPress={() => navigation.navigate('/')} />
        </View>
      </View>

      {/* 미리보기 — 오늘 값으로 만든 실제 문구.
          알림 동의를 구하기 전에 '무엇이 오는지'를 먼저 보여 준다. */}
      <Card palette={p} style={{ gap: 10 }}>
        <Text style={{ fontSize: 13, color: p.faint, fontWeight: '600' }}>이렇게 도착해요</Text>
        {brief ? (
          <>
            {/* 실제 알림에 나가는 문구(나스닥·공포탐욕) 그대로 */}
            <View
              style={{
                backgroundColor: p.sunken,
                borderRadius: 12,
                paddingVertical: 14,
                paddingHorizontal: 16,
              }}
            >
              <Text style={{ fontSize: 15, color: p.text, lineHeight: 23, fontWeight: '600' }}>
                {brief.pushBody || brief.line || '지금은 지수를 불러올 수 없어요.'}
              </Text>
            </View>
            {brief.asOf ? (
              <Text style={{ fontSize: 12, color: p.faint }}>{brief.asOf} 기준</Text>
            ) : null}
            {/* 알림엔 두 개만, 앱에선 전부 — 무엇이 더 있는지 켜기 전에 알 수 있게 */}
            {brief.pushDropped && brief.pushDropped.length > 0 ? (
              <Text style={{ fontSize: 13, color: p.sub, lineHeight: 20 }}>
                {brief.pushDropped.join('·')}까지 보고 싶으면 알림을 눌러 앱에서 확인하세요.
              </Text>
            ) : null}
            {/* 옆의 pushDropped 처럼 존재 여부부터 본다. 타입에는 필수로 적혀
                있지만 응답은 무검증 캐스팅이라, 서버가 이 필드를 빼는 순간
                여기서 TypeError 가 나고 에러 바운더리가 앱 전체를 덮는다. */}
            {brief.missing && brief.missing.length > 0 ? (
              <Text style={{ fontSize: 13, color: p.faint, lineHeight: 20 }}>
                오늘은 {brief.missing.join('·')} 값을 받지 못했어요. 못 받은 항목은 빈칸을 남기지
                않고 문구에서 빠집니다.
              </Text>
            ) : null}
          </>
        ) : briefFailed ? (
          <Text style={{ fontSize: 15, color: p.sub, lineHeight: 23 }}>
            미국 장이 열린 다음 날(화~토) 아침, 나스닥 지수와 미국 공포탐욕지수를 한 줄로 보내 드려요. (나머지 지수는 알림을
            눌러 앱에서 볼 수 있어요.)
          </Text>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ActivityIndicator color={p.primary} />
            <Text style={{ fontSize: 13, color: p.sub }}>미리보기 불러오는 중…</Text>
          </View>
        )}
      </Card>

      {/* 스위치 */}
      <Card palette={p} style={{ gap: 14 }}>
        {push.loading ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 }}>
            <ActivityIndicator color={p.primary} />
            <Text style={{ fontSize: 14, color: p.sub }}>알림 상태 확인 중…</Text>
          </View>
        ) : (
          <>
            <Text style={{ fontSize: 17, fontWeight: '700', color: p.text }}>
              {push.enabled ? `알림을 받고 있어요 · ${PUSH_TIME_LABEL}` : '아직 받지 않고 있어요'}
            </Text>
            <PrimaryButton
              label={push.busy ? '처리 중…' : push.enabled ? '알림 끄기' : '아침 알림 받기'}
              disabled={push.busy || !available || push.unsupported}
              palette={p}
              tone={push.enabled ? 'secondary' : 'primary'}
              // 켜는 순간만 기록한다 — 끄기는 전환이 아니다
              logName={push.enabled ? undefined : LOG.pushEnable}
              onPress={push.toggle}
            />
          </>
        )}

        {push.unsupported ? (
          <Text style={{ fontSize: 13.5, color: p.sub, lineHeight: 21 }}>
            토스 앱을 최신 버전으로 업데이트하면 알림을 켤 수 있어요.
          </Text>
        ) : null}
        {!available ? (
          <Text style={{ fontSize: 13.5, color: p.sub, lineHeight: 21 }}>
            알림 기능을 준비 중이에요. 조금만 기다려 주세요.
          </Text>
        ) : null}
        {push.serverNotReady ? (
          <Text style={{ fontSize: 13.5, color: p.sub, lineHeight: 21 }}>
            서버가 알림을 준비 중이에요. 잠시 후 다시 시도해 주세요.
          </Text>
        ) : null}
        {push.problem ? (
          <Text style={{ fontSize: 13.5, color: p.danger, lineHeight: 21 }}>{push.problem}</Text>
        ) : null}
      </Card>

      {/* 관심종목 알림 — 아침 알림과 따로 켠다 */}
      {push.enabled ? (
        <Card palette={p} style={{ gap: 12 }}>
          <Text style={{ fontSize: 17, fontWeight: '700', color: p.text }}>관심종목 알림</Text>
          <Text style={{ fontSize: 14, color: p.sub, lineHeight: 22 }}>
            담아 두신 종목이 오늘 검증된 지지선에 닿으면, 아침 알림을 그 소식으로
            바꿔 보내 드려요. 닿은 종목이 없는 날은 평소처럼 지수를 보내요.
          </Text>
          <Notice palette={p}>
            켜시면 담아 두신 종목의 <Text style={{ fontWeight: '700' }}>종목코드만</Text> 서버에
            저장돼요 (최근 {WATCH_ALERT_MAX}개까지). 종목 이름·수량·매수가는 저장하지 않고, 끄시면 즉시
            지워집니다. 알림에는 개수만 적혀요 — 잠금화면에 종목 이름이 뜨지 않게요.
          </Notice>
          <PrimaryButton
            label={
              watchBusy
                ? '처리 중…'
                : watchAlert.on
                  ? '관심종목 알림 끄기'
                  : watchedReady
                    ? `관심종목 알림 받기 (${watchedForAlert(watched.length)}개)`
                    : '관심종목 확인 중…'
            }
            disabled={watchBusy || !watchedReady || (!watchAlert.on && watched.length === 0)}
            palette={p}
            tone={watchAlert.on ? 'secondary' : 'primary'}
            onPress={() => {
              setWatchBusy(true);
              setWatchProblem(null);
              void watchAlert
                .setOn(!watchAlert.on)
                .catch((err) =>
                  setWatchProblem(
                    err instanceof Error ? err.message : '설정을 저장하지 못했어요.',
                  ),
                )
                .finally(() => setWatchBusy(false));
            }}
          />
          {watchedReady && !watchAlert.on && watched.length === 0 ? (
            <Text style={{ fontSize: 13.5, color: p.sub, lineHeight: 21 }}>
              먼저 관심종목을 담아 주세요. 종목 오른쪽 위의 ☆ 를 누르면 담깁니다.
            </Text>
          ) : null}
          {watchAlert.on ? (
            <Text style={{ fontSize: 13, color: p.faint, lineHeight: 20 }}>
              지금 {watchedForAlert(watched.length)}개를 보고 있어요. 관심종목을 더하거나
              빼면 자동으로 맞춰집니다.
              {watched.length > WATCH_ALERT_MAX
                ? ` 담아 두신 ${watched.length}개 중 최근 ${WATCH_ALERT_MAX}개만 봅니다.`
                : ''}
            </Text>
          ) : null}
          {watchProblem ? (
            <Text style={{ fontSize: 13.5, color: p.danger, lineHeight: 21 }}>{watchProblem}</Text>
          ) : null}
        </Card>
      ) : null}

      {/* 무엇을 저장하는지 — 켜기 전에 알 수 있어야 한다 */}
      <Card palette={p} style={{ gap: 8 }}>
        <Text style={{ fontSize: 13, color: p.faint, fontWeight: '600' }}>알아두실 점</Text>
        <Text style={{ fontSize: 13.5, color: p.sub, lineHeight: 21 }}>
          · 알림을 켜면 보내 드릴 대상을 구분하기 위해 토스가 발급한 기기 식별값 하나를 저장해요.
          이름·연락처는 저장하지 않아요.
        </Text>
        <Text style={{ fontSize: 13.5, color: p.sub, lineHeight: 21 }}>
          · 관심종목은 기본적으로 이 기기에만 있어요. 위의 '관심종목 알림'을 따로 켜신
          경우에만 종목코드가 서버에 저장되고, 끄시면 즉시 지워집니다.
        </Text>
        <Text style={{ fontSize: 13.5, color: p.sub, lineHeight: 21 }}>
          · &apos;알림 끄기&apos;를 누르면 저장한 식별값을 지우고 발송 목록에서 빠져요. 토스에
          하신 알림 동의 자체는 토스 앱 설정에 남아 있어요.
        </Text>
        <Text style={{ fontSize: 13.5, color: p.sub, lineHeight: 21 }}>
          · 지수는 시장 상황에 따라 값을 못 받는 날이 있어요. 그럴 땐 받은 항목만 보내 드려요.
        </Text>
        <Text style={{ fontSize: 13.5, color: p.sub, lineHeight: 21 }}>
          · 알림이 오지 않으면 토스 앱 설정 → 알림에서 이 미니앱 알림이 켜져 있는지 확인해 주세요.
        </Text>
        <Text style={{ fontSize: 13.5, color: p.sub, lineHeight: 21 }}>
          · 공포탐욕지수는 CNN Business 의 Fear &amp; Greed Index 수치를 그대로 전해 드리는
          것으로, 저희와 제휴 관계는 없어요.
        </Text>
      </Card>

      <Footer palette={p} />
    </ScrollView>
  );
}
