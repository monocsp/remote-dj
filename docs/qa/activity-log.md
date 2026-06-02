# 인수: Activity Log

`LOG-` 시나리오. SPEC §Activity Log 스키마, §프로토콜 `activity`/`activityLog`,
§검증(track_change reason non-null), ARCHITECTURE(로그 캡).

---

## LOG-01 — 모든 조작은 activity 1건으로 기록·브로드캐스트
SPEC: §Activity — 각 조작은 ActivityEntry 1건으로 기록되어 `activity` 로 브로드캐스트.

- **Given** Player + Controller가 같은 방
- **When** Controller가 changeTrack / setVolume / togglePlay / updateSettings 각각 수행
- **Then** 매 조작마다 방 전체가 `activity` 1건 수신, type 이 각각
  `track_change` / `volume` / (`play`|`pause`) / `settings`

## LOG-02 — track_change 의 reason 은 non-null
SPEC: §Activity — `track_change` 는 항상 reason non-null.

- **Given** 유효한 곡 변경
- **When** activity 수신
- **Then** `type==='track_change'` 인 항목의 reason 이 non-null

## LOG-03 — 사유 선택 조작은 미입력 시 reason=null
SPEC: §검증 — 그 외 사유 선택, 비어있으면 null.

- **Given** 방의 controller
- **When** reason 없이 setVolume / togglePlay
- **Then** 해당 activity.reason === null

## LOG-04 — 사유 입력 시 트림되어 기록
SPEC: §Activity — reason 기록(트림).

- **Given** 방의 controller
- **When** reason `'  통화 중이라 줄임  '` 로 setVolume
- **Then** activity.reason === `'통화 중이라 줄임'`

## LOG-05 — join 시 전체 로그가 activityLog 로 전달
SPEC: §프로토콜 `activityLog` — join 직후 전체 로그 1회.

- **Given** Controller A가 조작 3건을 한 방 `R`
- **When** Controller B가 `R` 에 새로 join
- **Then** B가 받은 `activityLog` 가 그 3건을 시간순으로 포함

## LOG-06 — actor 는 닉네임 또는 null(익명)
SPEC: §Activity — actor null = 익명.

- **Given** 닉네임 있는 controller와 익명 controller
- **When** 각각 조작
- **Then** activity.actor 가 각각 닉네임 / null

## LOG-07 — 로그는 상한선까지 캡(오래된 항목 제거)
SPEC/ARCHITECTURE: 로그는 최근 N건만 보관(append-only, 초과 시 앞에서 제거).

- **Given** 한 방에서 상한(현재 구현 200) 초과로 조작
- **When** join한 새 소켓이 activityLog 수신
- **Then** 길이가 상한 이하이며 가장 최근 항목들만 남는다(오래된 항목 드롭)

> 비고: 구체 상한값(200)은 구현 디테일이므로 테스트는 "상한 이하 + 최신 보존"
> 불변식으로 검증한다(정확한 숫자에 과결합하지 않는다).
