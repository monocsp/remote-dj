# 인수: 음량 / 재생 (volume & playback)

`VOL-`, `PLY-` 시나리오. SPEC §프로토콜 `setVolume`/`togglePlay`,
§검증(음량 클램프 / 제어 권한), §권한 규칙.

---

## VOL-01 — 음량은 0..100 정수로 클램프 (상한)
SPEC: §검증 — `clampVolume` = 반올림 후 0..100. 자동 보정(에러 아님).

- **Given** 방의 controller
- **When** `setVolume { volume: 150 }`
- **Then** ack `{ ok: true }`; state.volume === 100

## VOL-02 — 음량 클램프 (하한)
SPEC: §검증 — `clampVolume`.

- **Given** 방의 controller
- **When** `setVolume { volume: -20 }`
- **Then** ack `{ ok: true }`; state.volume === 0

## VOL-03 — 음량 반올림
SPEC: §검증 — `clampVolume` 반올림.

- **Given** 방의 controller
- **When** `setVolume { volume: 42.6 }`
- **Then** state.volume === 43

## VOL-04 — 음량 변경은 Player에 setVolume 반영 (web)
SPEC: §동기화 모델 — Player는 state.volume을 그대로 적용.

- **Given** Player + Controller, YouTube IFrame 모킹(setVolume 기록)
- **When** Controller 슬라이더로 음량 변경
- **Then** Player 스텁이 클램프된 값으로 `setVolume` 기록

## PLY-01 — 재생/일시정지 토글
SPEC: §프로토콜 `togglePlay` — activity는 `play` 또는 `pause` 로 기록.

- **Given** 방의 controller
- **When** `togglePlay { isPlaying: true }` 다음 `togglePlay { isPlaying: false }`
- **Then** state.isPlaying 이 각각 true → false, activity type 이 `play` → `pause`

## PLY-02 — 재생 토글은 Player의 play/pause 반영 (web)
SPEC: §화면 Player — state.isPlaying 적용.

- **Given** Player + Controller, IFrame 모킹
- **When** Controller가 재생/일시정지 토글
- **Then** Player 스텁이 `playVideo`/`pauseVideo` 기록

## PLY-03 — Player는 제어 이벤트를 발행하지 못한다 (controllers only)
SPEC: §검증 — role==='controller' 만 제어 가능. Player 발행 시 ack `{ ok:false }`. §권한 규칙.

- **Given** `player` 로 입장한 소켓
- **When** `setVolume` / `togglePlay` / `changeTrack` / `updateSettings` 중 하나 발행
- **Then** ack `{ ok: false }` (`controllers only` 류), 상태 불변

## VOL-05 — 음량 사유는 선택 (없으면 reason=null)
SPEC: §검증 — 그 외 사유 선택, 비어있으면 reason null.

- **Given** 방의 controller
- **When** reason 없이 setVolume
- **Then** 해당 activity.reason === null
