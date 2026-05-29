# 인수: 탐색(Seek) / 진행상황(Progress)

`SEEK-` 시나리오. SPEC §프로토콜 `seekTo`/`progress`,
§탐색(Seek)/진행상황(`lastSeek`/`progress` 모델, seekTo Controller 전용 + 사유 선택,
progress Player 전용 + 비로그), §권한 규칙, §데이터 타입(`RoomState.progress`/`lastSeek`).

---

## SEEK-01 — seekTo는 state.lastSeek를 갱신하고 seek로 기록
SPEC: §탐색/진행상황 — `seekTo` 는 `lastSeek` 갱신, activity `seek`.

- **Given** Player + Controller가 같은 방
- **When** Controller가 `seekTo { seconds: 42 }` (사유 없음)
- **Then** ack `{ ok: true }`; 방의 모든 소켓이 `state` 수신, `lastSeek.seconds === 42`;
  `activity` 1건 `type === 'seek'`, `detail.seconds === 42`

## SEEK-02 — seekTo 사유는 선택 (없으면 reason=null)
SPEC: §탐색/진행상황 — seekTo 사유는 선택.

- **Given** 방의 controller
- **When** 사유 없이 `seekTo { seconds: 10 }`
- **Then** ack `{ ok: true }`; `activity` 의 `reason === null`

## SEEK-03 — 음수 seconds는 거부
SPEC: §프로토콜 — `seconds` 가 유한수 `>= 0` 가 아니면 `invalid seconds`.

- **Given** 방의 controller
- **When** `seekTo { seconds: -5 }`
- **Then** ack `{ ok: false, error: 'invalid seconds' }`, `lastSeek` 불변

## SEEK-04 — 비유한 seconds는 거부
SPEC: §프로토콜 — `seconds` 가 유한수가 아니면 `invalid seconds`.

- **Given** 방의 controller
- **When** `seekTo { seconds: NaN }` 또는 숫자가 아닌 값
- **Then** ack `{ ok: false, error: 'invalid seconds' }`, `lastSeek` 불변

## SEEK-05 — seekTo는 Controller 전용
SPEC: §권한 — `seekTo` 는 controller만.

- **Given** Player가 입장한 방
- **When** Player가 `seekTo { seconds: 10 }` 발행
- **Then** ack `{ ok: false }` (`controllers only`)

## SEEK-06 — progress는 state.progress를 갱신하고 로그를 남기지 않음
SPEC: §탐색/진행상황 — `progress` 는 `progress` 갱신, **비로그**.

- **Given** Player + Controller가 같은 방
- **When** Player가 `progress { currentTime: 12, duration: 200 }`
- **Then** ack `{ ok: true }`; 방의 모든 소켓이 `state` 수신,
  `progress.currentTime === 12`, `progress.duration === 200`;
  **새 `activity` 항목이 생성되지 않음**(고빈도 보고는 로그 미기록)

## SEEK-07 — 잘못된 progress 값은 거부
SPEC: §프로토콜 — `currentTime`/`duration` 이 유한수 `>= 0` 가 아니면 `invalid progress`.

- **Given** Player가 입장한 방
- **When** Player가 `progress { currentTime: -1, duration: 200 }` 또는 비유한 값
- **Then** ack `{ ok: false, error: 'invalid progress' }`, `progress` 불변

## SEEK-08 — progress는 Player 전용
SPEC: §권한 — `progress` 는 player만.

- **Given** Controller가 입장한 방
- **When** Controller가 `progress { currentTime: 1, duration: 100 }` 발행
- **Then** ack `{ ok: false, error: 'player only' }`
