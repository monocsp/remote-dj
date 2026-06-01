# 인수: 반복 / 셔플 / 빈 큐 정책 (playback modes)

`MODE-` / `REPEAT-` / `SHUFFLE-` / `OFF-` 시나리오. SPEC §프로토콜 `setRepeat`/`setShuffle`,
§반복/셔플/다음곡 결정(advance 공유 + repeat 'one' 자동전용 + 수동 next 는 'one' 무시 +
빈 큐 정책 off:정지/all:history 루프), §Activity Log(`mode`), §권한 규칙.

---

## MODE-01 — setRepeat은 state.repeat를 브로드캐스트하고 mode로 기록
SPEC: §반복/셔플 — `setRepeat` 은 `repeat` 갱신, activity `mode`, detail `{repeat}`.

- **Given** Player + Controller가 같은 방
- **When** Player(메인)가 `setRepeat { mode: 'all' }` (메인-전용)
- **Then** ack `{ ok:true }`; 방의 소켓이 `state.repeat === 'all'` 수신;
  `activity` 1건 `type === 'mode'`, `detail.repeat === 'all'`

## MODE-02 — setShuffle은 state.shuffle를 브로드캐스트
SPEC: §반복/셔플 — `setShuffle` 은 `shuffle` 갱신.

- **Given** 방의 player
- **When** Player(메인)가 `setShuffle { shuffle: true }` (메인-전용)
- **Then** ack `{ ok:true }`; `state.shuffle === true`

## MODE-03 — setRepeat/setShuffle은 Player 전용(메인)
SPEC: §권한 — `setRepeat`/`setShuffle` 은 메인-전용(Player만).

- **Given** Controller가 입장한 방
- **When** Controller(게스트)가 `setRepeat` 또는 `setShuffle` 발행
- **Then** ack `{ ok:false, error:'player only' }`

## MODE-04 — 잘못된 repeat mode는 거부
SPEC: §프로토콜 — `mode` 가 off/one/all 이 아니면 `invalid mode`.

- **Given** 방의 controller
- **When** `setRepeat { mode: 'bogus' }`
- **Then** ack `{ ok:false, error:'invalid mode' }`

## REPEAT-ONE — 반복 'one'은 자동 종료 시 현재곡을 처음부터 재생
SPEC: §반복/셔플 — repeat 'one' on AUTO end → `lastSeek 0` + `isPlaying:true`, 같은 곡, 무로그.

- **Given** Player + Controller, Player가 `setRepeat { mode:'one' }`(메인-전용), `changeTrack` A 적용
- **When** Player가 `trackEnded {}`
- **Then** ack `{ ok:true }`; `state.lastSeek.seconds === 0`, `currentTrack.id` 그대로 A,
  `isPlaying === true`

## REPEAT-ALL — 빈 큐 + 반복 'all'은 history에서 되돌아 루프
SPEC: §반복/셔플 — queue empty + 'all' → 전체 재생목록(history+현재)로 풀 재구성, 처음부터.

- **Given** Player + Controller, Player가 `setRepeat { mode:'all' }`(메인-전용), `changeTrack` A, `enqueueTrack` B
- **When** Player가 `trackEnded` 1회 → 현재 B, 큐 0; 다시 `trackEnded`
- **Then** 두 번째 trackEnded 후 `currentTrack.id` 가 A 로 되돌아오고 `isPlaying === true`

## OFF-STOP — 빈 큐 + 반복 'off'는 재생 정지
SPEC: §반복/셔플 — queue empty + 'off' → `isPlaying:false`, currentTrack 유지.

- **Given** Player + Controller (repeat 기본 'off'), `changeTrack` A, 큐 비어있음
- **When** Player가 `trackEnded {}`
- **Then** ack `{ ok:true }`; `state.isPlaying === false`, `currentTrack.id` 그대로 A

## SHUFFLE — 셔플 on이면 수동 next가 무작위 큐 곡을 선택
SPEC: §반복/셔플 — advance 는 shuffle 이면 무작위 인덱스를 고른다(큐는 FIFO 유지).

- **Given** 방의 player, `setShuffle { shuffle:true }`, `enqueueTrack` B, `enqueueTrack` C
- **When** Player(메인)가 `nextTrack {}`
- **Then** ack `{ ok:true }`; `currentTrack.id ∈ {B, C}`(무작위 — 어느 쪽인지는 단정하지 않음),
  `queue.length === 1`

## SHUFFLE-NEXT-IGNORES-ONE — 수동 next는 반복 'one'을 무시
SPEC: §반복/셔플 — 수동 next ALWAYS advances(repeat 'one' 무시).

- **Given** 방의 player, `setRepeat { mode:'one' }`, `changeTrack` A, `enqueueTrack` B
- **When** Player(메인)가 `nextTrack {}`
- **Then** `currentTrack.id === B`(현재곡 반복이 아니라 다음 곡으로 진행), `queue.length === 0`
