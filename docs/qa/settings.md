# 인수: 설정(Settings) / 익명 제한(allowAnonymous)

`SET-` 시나리오. SPEC §설정(RoomSettings / allowAnonymous), §검증 규칙(익명 콘텐츠 제한),
§프로토콜 `updateSettings`, §화면별 명세 Controller 설정 섹션, §데이터 타입(`RoomSettings`).

핵심 규칙:
- `updateSettings` 는 설정을 **부분 병합**하고, `state` 브로드캐스트 + `'settings'` activity 1건을 남긴다.
- `settings.allowAnonymous === false` 이면 **콘텐츠 액션**(`changeTrack`/`enqueueTrack`/`nextTrack`)은
  닉네임 없는 소켓에서 `{ ok:false, error:'nickname required' }` 로 거부된다.
- `updateSettings`/`setVolume` 등 저위험 제어는 게이트하지 않는다(잠금 방지 — 설정은 항상 되돌릴 수 있다).

---

## SET-01 — updateSettings는 새 설정을 브로드캐스트하고 settings로 기록
SPEC: §설정 — `updateSettings` 는 병합 + `state` 브로드캐스트 + activity `settings`.

- **Given** 방에 controller(설정 변경자)와 다른 멤버(observer)가 있다
- **When** controller가 `updateSettings { settings: { allowAnonymous: false } }`
- **Then** ack `{ ok: true }`; 방의 모든 소켓이 `state` 수신,
  `settings.allowAnonymous === false`; `activity` 1건 `type === 'settings'`
- **(E2E)** Controller A가 "익명 허용" 체크박스를 끄면, Controller B의 UI에서
  체크박스가 해제되고 "닉네임이 있어야 곡을 변경할 수 있어요" 힌트가 보인다

## SET-02 — allowAnonymous=false에서 익명 컨트롤러의 changeTrack 거부
SPEC: §검증 규칙 — 익명 콘텐츠 제한 → `nickname required`.

- **Given** 닉네임 없이 입장한 controller가 `allowAnonymous=false` 로 설정
- **When** 그 controller가 `changeTrack { url, reason }`
- **Then** ack `{ ok: false, error: 'nickname required' }`

## SET-03 — 닉네임 있는 컨트롤러는 changeTrack 허용
SPEC: §검증 규칙 — 제한은 닉네임 없는 소켓에만 적용.

- **Given** 닉네임을 가진 controller가 `allowAnonymous=false` 로 설정
- **When** 그 controller가 `changeTrack { url, reason }`
- **Then** ack `{ ok: true }`; `state.currentTrack.id` 가 해당 트랙으로 바뀜

## SET-04 — 저위험 제어는 게이트 제외 (잠금 방지)
SPEC: §설정 — 게이트 제외(`setVolume` 등은 익명도 허용).

- **Given** 닉네임 없이 입장한 controller가 `allowAnonymous=false` 로 설정
- **When** 그 controller가 `setVolume { volume: 42 }`
- **Then** ack `{ ok: true }`; `state.volume === 42` (익명이어도 차단되지 않음)
