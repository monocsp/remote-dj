# SPEC — remote-dj 제품/프로토콜 명세

이 문서는 remote-dj의 **계약(contract)** 을 정의한다. 여기 적힌 이벤트/타입/검증 규칙은 클라이언트와 서버가 동일하게 따라야 하는 단일 진실 공급원이다.

## 개요

remote-dj는 협업형 음악 컨트롤러다. 한 대의 **Player** 폰이 YouTube로 음악을 재생하고, 여러 대의 **Controller** 폰이 실시간으로 곡/음량/설정을 원격 조작한다. 모든 조작은 **Activity Log** 에 기록된다. 곡 변경에는 **사유(reason)가 필수**이며, 그 외 조작의 사유는 선택이다. 사용자는 **기본 익명**이며, 닉네임은 선택적으로 입력할 수 있다.

## 역할 정의

```ts
type Role = 'player' | 'controller';
```

| 역할 | 권한 | 비고 |
| --- | --- | --- |
| **Player** | `join` 만 가능, 이후 `state`/`activity` 수신 | YouTube 재생을 위해 YouTube 로그인 선행 필요. 제어 이벤트를 발행하지 **못함** |
| **Controller** | `join` + 모든 제어 이벤트(`changeTrack`/`setVolume`/`togglePlay`/`updateSettings`) | 휴대폰 화면 기준 반응형 웹 |

## 화면별 명세

### Landing `/`
- 역할 선택(Player / Controller)
- 방 코드 입력 또는 신규 생성
- 닉네임 입력(선택)
- 선택에 따라 `/player?room=CODE` 또는 `/controller?room=CODE` 로 이동

### Player `/player?room=CODE`
- YouTube **IFrame Player API** 로 실제 재생
- 서버에서 받은 `state` 를 그대로 적용(currentTrack / isPlaying / volume)
- 참가 안내를 위해 방 코드 및 **QR**(추후) 표시
- 제어 UI 없음 — 상태 수신 전용

### Controller `/controller?room=CODE`
- **now-playing 카드**: 현재 곡 제목/링크
- **곡 변경 폼**: URL + **사유 필수** + 제목(선택)
- **음량 슬라이더**: 0–100
- **재생/일시정지** 토글
- **Activity Log 피드**: 신규 항목 실시간 추가

## WebSocket 프로토콜

전송 계층은 **Socket.IO**. 모든 Client→Server 이벤트는 **ack 콜백** 을 가지며 `{ ok: boolean; error?: string }` 를 반환한다. 제어 이벤트는 **Controller 만** 발행할 수 있다(Player가 발행 시 ack `{ ok:false }`).

### 이벤트 표

| 이름 | 방향 | 페이로드 | ack / 결과 |
| --- | --- | --- | --- |
| `join` | C→S | `{ roomCode: string; role: Role; nickname?: string }` | `{ ok, error? }`; 성공 시 해당 소켓에 `state` + `activityLog` 전송 |
| `changeTrack` | C→S | `{ url: string; reason: string; title?: string }` | reason이 trim 후 빈 문자열이면 `{ ok:false, error }`; url에서 video id 파싱 실패 시 `{ ok:false, error }` |
| `setVolume` | C→S | `{ volume: number; reason?: string }` | 서버가 `clampVolume` 으로 0..100 정수 보정 후 적용 |
| `togglePlay` | C→S | `{ isPlaying: boolean; reason?: string }` | activity는 `play` 또는 `pause` 로 기록 |
| `updateSettings` | C→S | `{ settings: Partial<RoomSettings>; reason?: string }` | 부분 병합 |
| `state` | S→C | `RoomState` | join 직후 + 모든 변경 후 브로드캐스트 |
| `activity` | S→C | `ActivityEntry` | 신규 항목 1건 |
| `activityLog` | S→C | `ActivityEntry[]` | join 직후 전체 로그 |

데이터 흐름: Controller가 제어 이벤트 발행 → 서버가 검증 → 권위 상태(RoomState) 갱신 → 방 전체에 `state` 브로드캐스트 + 신규 `activity` 브로드캐스트.

## 데이터 타입

```ts
type Role = 'player' | 'controller';

interface Track {
  id: string;            // YouTube video id
  url: string;
  title: string | null;
  addedBy: string | null; // null = 익명
}

interface RoomSettings {
  allowAnonymous: boolean; // 확장 가능
}

interface RoomState {
  roomCode: string;
  currentTrack: Track | null;
  isPlaying: boolean;
  volume: number;          // 0-100
  settings: RoomSettings;
  presence: { playerConnected: boolean; controllers: number };
  updatedAt: number;       // epoch ms
}

type ActivityType = 'track_change' | 'volume' | 'play' | 'pause' | 'settings';

interface ActivityEntry {
  id: string;
  ts: number;              // epoch ms
  actor: string | null;    // null = 익명
  type: ActivityType;
  reason: string | null;
  detail?: Record<string, unknown>;
}
```

## 검증 규칙

| 대상 | 규칙 | 위반 시 |
| --- | --- | --- |
| 곡 변경 사유 | `validateReason(reason)` = trim 후 비어있지 않음 | ack `{ ok:false, error:'reason required' }` |
| 곡 URL | `parseYouTubeId(url)` 가 video id 반환(비-null) | ack `{ ok:false, error:'invalid youtube url' }` |
| 음량 | `clampVolume(v)` = 반올림 후 0..100 클램프 | 자동 보정(에러 아님) |
| 제어 권한 | role === `'controller'` | Player가 발행 시 ack `{ ok:false }` |
| 그 외 사유 | 선택 — 비어있으면 `reason: null` 로 기록 | — |

### 공유 유틸 (packages/shared)

| 함수 | 시그니처 | 설명 |
| --- | --- | --- |
| `parseYouTubeId` | `(url: string) => string \| null` | 다양한 YouTube URL 형태에서 video id 추출, 실패 시 null |
| `validateReason` | `(r: string) => boolean` | trim 후 비어있지 않으면 true |
| `clampVolume` | `(v: number) => number` | 반올림 후 0..100 |
| `generateRoomCode` | `() => string` | 6자 룸 코드 생성 |

## Activity Log 스키마 + 예시

각 조작은 `ActivityEntry` 1건으로 기록되어 `activity` 로 브로드캐스트되고 전체 로그는 join 시 `activityLog` 로 전달된다.

| id | ts | actor | type | reason | detail |
| --- | --- | --- | --- | --- | --- |
| a1 | 1748... | null | `track_change` | "분위기 띄우려고" | `{ title, url, id }` |
| a2 | 1748... | "철수" | `volume` | "통화 중이라 줄임" | `{ volume: 30 }` |
| a3 | 1748... | null | `pause` | null | — |
| a4 | 1748... | "영희" | `settings` | null | `{ allowAnonymous: false }` |

- `actor` 가 `null` 이면 익명으로 표시한다.
- `track_change` 는 항상 `reason` 이 non-null이다(검증 규칙).

## 페어링(룸 코드) 규칙

- 형식: **6자 대문자** 룸 코드.
- charset: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — 혼동되는 문자(I, O, 0, 1 등) 제외.
- `generateRoomCode()` 가 위 charset에서 6자를 무작위 생성.
- QR 코드는 추후 add-on(룸 코드를 인코딩).

## 권한 규칙 (누가 무엇을)

| 동작 | Player | Controller |
| --- | --- | --- |
| `join` | O | O |
| `state`/`activity`/`activityLog` 수신 | O | O |
| `changeTrack` | X | O |
| `setVolume` | X | O |
| `togglePlay` | X | O |
| `updateSettings` | X | O |

## 비범위 (추후)

- 인증/세션 정책(현재는 익명 + 선택 닉네임)
- QR 코드 페어링
- 영속 저장소(SQLite/Postgres) — 현재는 인메모리
- 재생 큐/플레이리스트(현재는 단일 currentTrack)
- 사용자 강퇴/방장 권한
