# 인수: 곡 변경 (track change)

`TRK-` 시나리오. SPEC §프로토콜 `changeTrack`, §검증(사유 필수 / URL 파싱),
§Activity Log(`track_change` reason non-null).

---

## TRK-01 — 사유 없는 곡 변경은 거부 (reason required)
SPEC: §검증 — `validateReason` trim 후 빈 문자열이면 거부.

- **Given** 방에 입장한 controller, 유효한 YouTube URL
- **When** `changeTrack { url, reason: '' }` (또는 공백만)
- **Then** ack `{ ok: false, error: 'reason required' }`, 상태/로그 불변

## TRK-02 — 잘못된 YouTube URL은 거부 (invalid youtube url)
SPEC: §검증 — `parseYouTubeId` 가 null이면 거부.

- **Given** 방에 입장한 controller, 사유 `'테스트'`
- **When** `changeTrack { url: 'https://example.com/x', reason: '테스트' }`
- **Then** ack `{ ok: false, error: 'invalid youtube url' }`, 상태 불변

## TRK-03 — 유효한 곡 변경은 성공하고 state 브로드캐스트
SPEC: §프로토콜 — 검증 통과 시 RoomState 갱신 + 방 전체에 `state` 브로드캐스트.

- **Given** Player + Controller가 같은 방
- **When** Controller가 `changeTrack { url: 'https://youtu.be/dQw4w9WgXcQ', reason: '분위기 띄우려고' }`
- **Then** ack `{ ok: true }`; 방의 모든 소켓이 `state` 수신, `currentTrack.id === 'dQw4w9WgXcQ'`,
  `isPlaying === true`

## TRK-04 — 곡 변경은 activity로 기록되며 reason은 non-null
SPEC: §검증/§Activity — `track_change` 는 항상 reason non-null, detail에 `{ id, url, title }`.

- **Given** TRK-03 상황
- **When** 곡 변경이 성공
- **Then** `activity` 1건 수신, `type==='track_change'`, `reason` 이 non-null(트림된 사유),
  `detail.id` 가 video id

## TRK-05 — 제목은 선택 (없으면 title=null)
SPEC: §데이터 타입 Track.title `string | null`.

- **Given** 방의 controller
- **When** title 없이 유효 changeTrack
- **Then** state.currentTrack.title === null

## TRK-06 — 곡 변경은 Player의 YouTube 재생을 갱신 (web)
SPEC: §화면 Player — 받은 state를 그대로 적용(currentTrack). §동기화 모델.

- **Given** Player + Controller, YouTube IFrame은 모킹(loadVideoById 기록)
- **When** Controller가 유효 곡 변경
- **Then** Player의 `window.YT` 스텁이 해당 video id로 `loadVideoById` 를 기록

## TRK-07 — URL/사유/제목 길이 초과는 거부
SPEC: §검증 — `withinLimit` url 2048 / reason 500 / title 200.

- **Given** 방의 controller
- **When** url 2049자 또는 reason 501자 또는 title 201자
- **Then** ack `{ ok: false }` (`input too long` 류), 상태 불변

## TITLE-01 — 제목 없는 곡 변경은 서버가 YouTube oEmbed로 비동기 채움
SPEC: §재생 큐 — 제목 자동 채움(best-effort, 비차단, fire-and-forget).

- **Given** 방에 입장한 controller (테스트에선 결정적 리졸버/`REMOTE_DJ_FAKE_TITLE` 사용)
- **When** title 없이 유효 `changeTrack`
- **Then** ack `{ ok: true }` 는 즉시 반환되고(차단 없음), 이후 `state` 재브로드캐스트에서
  `currentTrack.title` 이 리졸버가 돌려준 제목으로 채워진다(초기 브로드캐스트는 `title: null` 일 수 있음 — predicate 로 대기)

## TITLE-02 — 명시된 제목은 자동 채움이 덮어쓰지 않음
SPEC: §재생 큐 — 이미 non-null 인 `title` 은 enrich 가 건드리지 않음.

- **Given** 방에 입장한 controller
- **When** title `'My Title'` 을 명시한 유효 `changeTrack`
- **Then** `currentTrack.title === 'My Title'` 로 유지(자동 채움이 스킵됨)
