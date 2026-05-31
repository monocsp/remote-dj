# 인수: 재생 오류(Playback Error) / 복구

`ERR-` 시나리오. SPEC §프로토콜 `playbackError`, §재생 오류(Playback Error)/복구
(Player 전용 + 비로그 + 상태로만 노출, 새 곡 시도 시 초기화), §권한 규칙,
§데이터 타입(`RoomState.playbackError`).

---

## ERR-01 — playbackError는 state.playbackError를 갱신한다
SPEC: §재생 오류/복구 — `playbackError` 는 `playbackError` 갱신, 브로드캐스트, 비로그.

- **Given** Player + Controller가 같은 방
- **When** Player가 `playbackError { code: 100 }`
- **Then** ack `{ ok: true }`; 방의 모든 소켓이 `state` 수신, `playbackError.code === 100`;
  **새 `activity` 항목이 생성되지 않음**(상태로만 노출)

## ERR-02 — 새 곡(changeTrack) 시 playbackError가 초기화된다
SPEC: §재생 오류/복구 — 새 곡 시도 시(`changeTrack`/`nextTrack`/`trackEnded`) `playbackError: null`.

- **Given** Player가 `playbackError { code: 100 }` 를 보내 오류가 설정된 방
- **When** Controller가 `changeTrack { url, reason }`
- **Then** ack `{ ok: true }`; 브로드캐스트된 `state.currentTrack` 이 새 곡이고
  `state.playbackError === null`

## ERR-03 — playbackError는 Player 전용
SPEC: §권한 — `playbackError` 는 player만.

- **Given** Controller가 입장한 방
- **When** Controller가 `playbackError { code: 100 }` 발행
- **Then** ack `{ ok: false, error: 'player only' }`

## ERR-04 — 비유한 code는 거부
SPEC: §프로토콜 — `code` 가 유한수가 아니면 `invalid code`.

- **Given** Player가 입장한 방
- **When** Player가 `playbackError { code: NaN }` 또는 숫자가 아닌 값
- **Then** ack `{ ok: false, error: 'invalid code' }`, `playbackError` 불변
