# 인수: 재생 큐 (queue / playlist)

`QUEUE-` 시나리오. SPEC §프로토콜 `enqueueTrack`/`removeQueued`/`nextTrack`/`trackEnded`,
§재생 큐(모델 + 사유 선택 vs changeTrack 사유 필수 + trackEnded Player 전용),
§Activity Log(`enqueue`/`dequeue`/`skip`), §권한 규칙.

---

## QUEUE-01 — 재생 중일 때 곡 추가는 state.queue에 쌓이고 enqueue로 기록
SPEC: §재생 큐 — `enqueueTrack` 은 큐 끝에 Track 추가, activity `enqueue`.
**전제**: 방이 IDLE 이면 첫 enqueue 는 auto-start 되므로(QUEUE-14), 큐잉을 검증하려면
먼저 다른 곡으로 재생 중 상태를 만든다(`changeTrack` 또는 한 번 enqueue 하여 auto-start).

- **Given** Player + Controller가 같은 방, 이미 `currentTrack` 이 재생 중
  (예: `changeTrack { url: '...dQw4w9WgXcQ', reason }` 로 A 를 현재 곡으로 만든 뒤)
- **When** Controller가 `enqueueTrack { url: 'https://youtu.be/9bZkp7q19f0' }` (사유 없음)
- **Then** ack `{ ok: true }`; 방의 모든 소켓이 `state` 수신, `queue` 에 `id === '9bZkp7q19f0'` 곡 포함,
  `currentTrack` 은 변하지 않음(A 유지); `activity` 1건 `type === 'enqueue'`

## QUEUE-02 — 곡 추가 사유는 선택 (없으면 reason=null)
SPEC: §재생 큐 — enqueue 사유는 선택.

- **Given** 방의 controller
- **When** 사유 없이 `enqueueTrack`
- **Then** ack `{ ok: true }`; `activity` 의 `reason === null`

## QUEUE-03 — 잘못된 YouTube URL 추가는 거부
SPEC: §검증 — `parseYouTubeId` 가 null이면 거부.

- **Given** 방의 controller
- **When** `enqueueTrack { url: 'https://example.com/x' }`
- **Then** ack `{ ok: false, error: 'invalid youtube url' }`, 큐 불변

## QUEUE-04 — URL/사유/제목 길이 초과 추가는 거부
SPEC: §검증 — `withinLimit` url 2048 / reason 500 / title 200.

- **Given** 방의 controller
- **When** url 2049자 또는 reason 501자 또는 title 201자로 `enqueueTrack`
- **Then** ack `{ ok: false }` (`input too long`), 큐 불변

## QUEUE-05 — removeQueued로 큐에서 제거
SPEC: §재생 큐 — 유효 index의 곡 제거, activity `dequeue`.

- **Given** 큐에 1곡 이상 있는 controller
- **When** `removeQueued { index: 0 }`
- **Then** ack `{ ok: true }`; 해당 곡이 `state.queue` 에서 사라짐; `activity` `type === 'dequeue'`

## QUEUE-06 — 범위 밖 index 제거는 거부
SPEC: §재생 큐 — `index` 가 `[0, queue.length)` 정수가 아니면 거부.

- **Given** 방의 controller (큐 비어있거나 짧음)
- **When** `removeQueued { index: 5 }`
- **Then** ack `{ ok: false, error: 'invalid index' }`, 큐 불변

## QUEUE-07 — nextTrack은 큐 맨 앞을 currentTrack으로 승격하고 큐를 줄임
SPEC: §재생 큐 — `nextTrack` 큐 비어있지 않으면 head→currentTrack, isPlaying:true, activity `skip`.
**전제**: 큐를 채우려면 먼저 다른 곡(A)을 재생 중으로 만든 뒤 B 를 enqueue 한다
(IDLE 방에 첫 enqueue 하면 B 가 곧장 auto-start 되어 큐에 남지 않으므로).

- **Given** 현재 곡 A 가 재생 중이고 큐에 `id === '9bZkp7q19f0'`(B) 1곡이 있는 controller
- **When** `nextTrack {}`
- **Then** ack `{ ok: true }`; `state.currentTrack.id === '9bZkp7q19f0'`, `queue.length === 0`,
  `isPlaying === true`; `activity` `type === 'skip'`

## QUEUE-08 — 빈 큐에서 nextTrack은 no-op 성공
SPEC: §재생 큐 — 큐가 비어있으면 `{ ok:true }` no-op(브로드캐스트 없음).

- **Given** 큐가 빈 방의 controller
- **When** `nextTrack {}`
- **Then** ack `{ ok: true }`; 상태/로그 불변

## QUEUE-09 — Player의 trackEnded는 큐를 자동 진행
SPEC: §재생 큐 — `trackEnded` (Player 전용)는 자동 next, activity `skip` detail `{auto:true}`.

- **Given** Player + Controller, 현재 곡 A 재생 중 + 큐에 `id === '9bZkp7q19f0'`(B) 1곡
  (IDLE 방에 첫 enqueue 하면 auto-start 되므로 먼저 A 를 재생 중으로 만든 뒤 B 를 enqueue)
- **When** Player가 `trackEnded {}`
- **Then** ack `{ ok: true }`; `state.currentTrack.id === '9bZkp7q19f0'`, `queue.length === 0`;
  `activity` `type === 'skip'`, `detail.auto === true`

## QUEUE-10 — 빈 큐에서 trackEnded는 재생 정지
SPEC: §재생 큐 — 큐가 비어있으면 `isPlaying:false`.

- **Given** Player가 있는 방, 큐가 비어있음
- **When** Player가 `trackEnded {}`
- **Then** ack `{ ok: true }`; `state.isPlaying === false`

## QUEUE-11 — 큐 제어는 Controller 전용
SPEC: §권한 — `enqueueTrack`/`removeQueued`/`nextTrack` 은 controller만.

- **Given** Player가 입장한 방
- **When** Player가 `enqueueTrack` 또는 `nextTrack` 발행
- **Then** ack `{ ok: false }` (`controllers only`)

## QUEUE-12 — trackEnded는 Player 전용
SPEC: §재생 큐/§권한 — `trackEnded` 는 player만.

- **Given** Controller가 입장한 방
- **When** Controller가 `trackEnded {}` 발행
- **Then** ack `{ ok: false, error: 'player only' }`

## QUEUE-13 — changeTrack은 큐 모델과 독립 (사유 필수, 큐 불변)
SPEC: §재생 큐 — `changeTrack` 은 사유 필수, `currentTrack` 만 설정, 큐 미변경.

- **Given** 큐에 곡이 있는 controller
- **When** 유효한 `changeTrack { url, reason }`
- **Then** ack `{ ok: true }`; `currentTrack` 이 새 곡으로, `state.queue` 는 그대로 유지
  (사유 빈 경우는 TRK-01대로 `reason required` 거부)

## QUEUE-14 — IDLE 방에 곡 추가는 즉시 재생 시작(auto-start)
SPEC: §재생 큐 — 방이 IDLE(`currentTrack === null`)일 때 `enqueueTrack` 은 추가한 곡을
즉시 `currentTrack` 으로 승격(`isPlaying:true`, `playbackError:null`)하고 큐를 비운다.
이미 재생 중이면 큐 끝(FIFO)에만 추가한다.

- **Given** 새로 만든 IDLE 방의 controller(`currentTrack === null`, `queue` 비어있음)
- **When** `enqueueTrack { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }` (사유 없음)
- **Then** ack `{ ok: true }`; 브로드캐스트 `state.currentTrack.id === 'dQw4w9WgXcQ'`,
  `isPlaying === true`, `queue.length === 0`; `activity` 1건 `type === 'enqueue'`
