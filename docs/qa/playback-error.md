# 인수: 재생 오류(Playback Error) / 복구

`ERR-` 시나리오. SPEC §프로토콜 `playbackError`, §재생 오류(Playback Error)/복구
(Player 전용 + activity `error` 로그 + 자동 다음 곡 진행/큐 비면 정지), §권한 규칙,
§데이터 타입(`RoomState.playbackError`).

> 참고: `changeTrack`/`enqueue` 의 임베드 거부 경로(`embed disabled`)는 블랙박스에서 검증 불가다 —
> 스폰된 서버는 `REMOTE_DJ_FAKE_TITLE` 가 설정돼 있어 임베드 검사가 항상 통과(fail-open, 무네트워크)한다.
> 해당 경로는 vitest EMB-01 통합 테스트에서 다룬다.

---

## ERR-01 — playbackError는 다음 곡으로 자동 스킵하고 error를 기록한다
SPEC: §재생 오류/복구 — 오류 보고 시 activity `error` 기록 후 큐가 있으면 자동 다음 곡 승격.

- **Given** Player + Controller가 같은 방, 현재 곡 A 재생 중 + 큐에 `id === '9bZkp7q19f0'`(B) 1곡
- **When** Player가 `playbackError { code: 150 }`
- **Then** ack `{ ok: true }`; 브로드캐스트된 `state.currentTrack.id === '9bZkp7q19f0'`(B로 자동 스킵);
  **`activity` 1건 `type === 'error'`, `detail.code === 150`**

## ERR-02 — 큐가 비어있으면 정지하고 오류를 유지한다
SPEC: §재생 오류/복구 — 큐가 비면 `isPlaying:false`, `playbackError = { code, ts, id }` 유지.

- **Given** Player + Controller가 같은 방, 현재 곡 A 재생 중 + 큐 비어있음
- **When** Player가 `playbackError { code: 2 }`
- **Then** ack `{ ok: true }`; `state.isPlaying === false`, `state.playbackError.code === 2`;
  `activity` 1건 `type === 'error'`

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
