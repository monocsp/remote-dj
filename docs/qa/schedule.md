# 인수: 주간 예약(스케줄) — 자동 재생/종료

`SCHED-` 시나리오. SPEC §프로토콜 `setSchedule`, §주간 예약(스케줄) — 자동 재생/종료
(**Player 전용** — 예약은 디바이스/운영 설정이며 Controller는 사운드 제어 전용, 검증,
분 단위 EDGE-triggered 전이, 시작→재개/큐 승격, 종료→정지, 수동 일시정지와 싸우지 않음,
영속), §권한 규칙, §데이터 타입(`RoomState.schedule`, `WeeklySchedule`),
§Activity Log(`schedule`).

> **블랙박스 범위 한계**: SCHED-01/02(설정/검증)만 over-the-wire 로 검증 가능하다.
> 시간 기반 자동 전이(SCHED-03/04/05)는 **서버의 벽시계(wall clock)** 에 의존하는데
> Python 하네스는 이를 제어할 수 없다. 따라서 이들은 vitest 통합 테스트에서
> `createServer` 가 반환하는 `tickSchedules(now)` 로 결정적인 `now` 를 주입해 검증한다.

---

## SCHED-01 — Player의 setSchedule은 state.schedule을 갱신하고 schedule 활동을 남긴다
SPEC: §주간 예약 — `setSchedule`(Player 전용) 저장·브로드캐스트, activity `schedule`(detail `{enabled}`).

- **Given** Player + Controller(observer)가 같은 방
- **When** Player가 `setSchedule { schedule }`(mon ON 09:00–18:00, 그 외 OFF, `enabled:true`)
- **Then** ack `{ ok: true }`; 방의 모든 소켓이 `state` 수신, `state.schedule.enabled === true`;
  `type === 'schedule'` 인 신규 `activity` 1건

## SCHED-02 — Player의 잘못된 스케줄(start>end 또는 비-HH:MM)은 거부된다
SPEC: §주간 예약 — 검증: 7개 요일 키, `on` boolean, `isHHMM(start)`/`isHHMM(end)`, `start < end`.

- **Given** Player가 입장한 방
- **When** Player가 `setSchedule` 에 `start > end`(예: 18:00→09:00) 또는 잘못된 HH:MM(예: 25:99)을 전달
- **Then** ack `{ ok: false, error: 'invalid schedule' }`; `state.schedule` 불변

## SCHED-06 — Controller의 setSchedule은 거부된다(Player 전용)
SPEC: §권한 규칙 — `setSchedule` 은 Player 전용(예약은 디바이스/운영 설정).

- **Given** Controller가 입장한 방
- **When** Controller가 `setSchedule { schedule }` 발행
- **Then** ack `{ ok: false, error: 'player only' }`

## SCHED-03 — 윈도우 안의 가장자리에서 자동으로 재생을 시작한다
SPEC: §주간 예약 — want `true` 가장자리 + 정지 상태 ⇒ 시작(현재곡 재개/큐 승격).

- **Given** Player가 mon 09–18 예약을 설정하고 Controller가 곡 A를 `changeTrack` 한 뒤 수동으로 `togglePlay false`(정지)
- **When** `tickSchedules(MON_10)`(월 10:00 — 윈도우 안) 호출 → want가 `true` 로 전이(가장자리)
- **Then** `state.isPlaying === true`(현재곡 재개)

## SCHED-04 — 윈도우 밖의 가장자리에서 자동으로 종료한다
SPEC: §주간 예약 — want `false` 가장자리 + 재생 중 ⇒ 정지.

- **Given** 재생 중이고 mon 09–18 예약이 설정된 방
- **When** `tickSchedules(MON_20)`(월 20:00 — 윈도우 밖) 호출 → want가 `false` 로 전이(가장자리)
- **Then** `state.isPlaying === false`

## SCHED-05 — 윈도우 중간의 수동 일시정지와 싸우지 않는다(EDGE-triggered)
SPEC: §주간 예약 — 가장자리에서만 동작; 같은 윈도우 안 재호출은 가장자리가 아니므로 무동작.

- **Given** mon 09–18 예약 + 곡 A. `tickSchedules(MON_10)` 으로 자동 시작(가장자리) 후, 수동 `togglePlay false`(일시정지)
- **When** 같은 윈도우 안에서 `tickSchedules(MON_10:01)` 재호출(want는 여전히 `true` — 가장자리 아님)
- **Then** 스케줄러가 재생을 다시 켜지 **않는다** — `state.isPlaying` 은 `false` 유지
  (이후 `setVolume` 브로드캐스트로 확인)
