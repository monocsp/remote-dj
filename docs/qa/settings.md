# 인수: 설정(Settings) / 익명 제한(allowAnonymous)

`SET-` 시나리오. SPEC §설정(RoomSettings / allowAnonymous), §검증 규칙(익명 콘텐츠 제한),
§프로토콜 `updateSettings`, §화면별 명세 Controller 설정 섹션, §데이터 타입(`RoomSettings`).

핵심 규칙:
- `updateSettings` 는 **Player 전용(메인)**이며(controller가 발행 시 `player only`) 설정을 **부분 병합**하고,
  `state` 브로드캐스트 + `'settings'` activity 1건을 남긴다.
- `settings.allowAnonymous === false` 이면 **Controller(게스트)의 콘텐츠 액션**(`changeTrack`/`enqueueTrack`)은
  닉네임 없는 소켓에서 `{ ok:false, error:'nickname required' }` 로 거부된다. **Player(메인)는 게이트되지 않는다.**
- `setVolume`/`togglePlay`/`setTrackGain` 등 저위험 게스트 제어는 게이트하지 않는다.

---

## SET-01 — updateSettings는 새 설정을 브로드캐스트하고 settings로 기록
SPEC: §설정 — `updateSettings` 는 병합 + `state` 브로드캐스트 + activity `settings`.

- **Given** 방에 player(설정 변경자 — updateSettings는 메인-전용)와 controller(observer)가 있다
- **When** Player가 `updateSettings { settings: { allowAnonymous: false } }`
- **Then** ack `{ ok: true }`; 방의 모든 소켓이 `state` 수신,
  `settings.allowAnonymous === false`; `activity` 1건 `type === 'settings'`
- **(권한)** Controller가 `updateSettings` 발행 시 ack `{ ok:false, error:'player only' }`

## SET-02 — allowAnonymous=false에서 익명 컨트롤러의 changeTrack 거부
SPEC: §검증 규칙 — 익명 콘텐츠 제한(Controller 한정) → `nickname required`.

- **Given** Player가 `allowAnonymous=false` 로 설정; 닉네임 없이 입장한 controller
- **When** 그 controller가 `changeTrack { url, reason }`
- **Then** ack `{ ok: false, error: 'nickname required' }`
- **(메인 예외)** 닉네임 없는 **Player** 의 `changeTrack` 은 게이트되지 않음 → ack `{ ok: true }`

## SET-03 — 닉네임 있는 컨트롤러는 changeTrack 허용
SPEC: §검증 규칙 — 제한은 닉네임 없는 controller 소켓에만 적용.

- **Given** Player가 `allowAnonymous=false` 로 설정; 닉네임을 가진 controller
- **When** 그 controller가 `changeTrack { url, reason }`
- **Then** ack `{ ok: true }`; `state.currentTrack.id` 가 해당 트랙으로 바뀜

## SET-04 — 저위험 게스트 제어는 게이트 제외
SPEC: §설정 — 게이트 제외(`setVolume` 등은 익명 controller도 허용).

- **Given** Player가 `allowAnonymous=false` 로 설정; 닉네임 없이 입장한 controller
- **When** 그 controller가 `setVolume { volume: 42 }`
- **Then** ack `{ ok: true }`; `state.volume === 42` (익명이어도 차단되지 않음)
