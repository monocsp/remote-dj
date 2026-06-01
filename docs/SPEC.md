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
| `join` | C→S | `{ roomCode: string; role: Role; nickname?: string; password?: string }` | `{ ok, error? }`; 성공 시 해당 소켓에 `state` + `activityLog` 전송. 방에 비밀번호가 설정돼 있으면 일치해야 함(아래 보안 규칙) |
| `changeTrack` | C→S | `{ url: string; reason: string; title?: string }` | reason이 trim 후 빈 문자열이면 `{ ok:false, error }`; url에서 video id 파싱 실패 시 `{ ok:false, error }` |
| `setVolume` | C→S | `{ volume: number; reason?: string }` | 서버가 `clampVolume` 으로 0..100 정수 보정 후 적용 |
| `togglePlay` | C→S | `{ isPlaying: boolean; reason?: string }` | activity는 `play` 또는 `pause` 로 기록 |
| `updateSettings` | C→S | `{ settings: Partial<RoomSettings>; reason?: string }` | 부분 병합 |
| `enqueueTrack` | C→S | `{ url: string; reason?: string; title?: string }` | url 파싱 실패 시 `{ ok:false, error:'invalid youtube url' }`. **사유 선택**. 큐 끝에 추가, activity `enqueue` |
| `removeQueued` | C→S | `{ index: number; reason?: string }` | `index` 가 `[0, queue.length)` 정수가 아니면 `{ ok:false, error:'invalid index' }`. activity `dequeue` |
| `nextTrack` | C→S | `{ reason?: string }` | 큐가 있으면 맨 앞 곡을 `currentTrack` 으로 승격(`isPlaying:true`), activity `skip`. 큐가 비어있으면 `{ ok:true }` no-op. **사유 선택** |
| `trackEnded` | C→S | `{}` | **Player 전용**(controller가 발행 시 `{ ok:false, error:'player only' }`). 자동 next처럼 동작: 큐 있으면 승격(activity `skip`, detail `{auto:true}`), 비어있으면 `isPlaying:false` |
| `seekTo` | C→S | `{ seconds: number; reason?: string }` | **Controller 전용**. `seconds` 가 유한수 `>= 0` 가 아니면 `{ ok:false, error:'invalid seconds' }`. `lastSeek` 갱신, activity `seek`, detail `{seconds}`. **사유 선택** |
| `progress` | C→S | `{ currentTime: number; duration: number }` | **Player 전용**(controller가 발행 시 `{ ok:false, error:'player only' }`). `currentTime`/`duration` 이 유한수 `>= 0` 가 아니면 `{ ok:false, error:'invalid progress' }`. `progress` 갱신 + 브로드캐스트. **로그 기록 안 함**(고빈도) |
| `playbackError` | C→S | `{ code: number }` | **Player 전용**(controller가 발행 시 `{ ok:false, error:'player only' }`). `code` 가 유한수가 아니면 `{ ok:false, error:'invalid code' }`. `playbackError = { code, ts }` 갱신 + 브로드캐스트. **로그 기록 안 함**(상태로만 노출). 새 곡 시도 시 초기화 |
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
  queue: Track[];          // currentTrack 다음에 순서대로 재생될 대기열
  isPlaying: boolean;
  volume: number;          // 0-100
  settings: RoomSettings;
  presence: { playerConnected: boolean; controllers: number };
  updatedAt: number;       // epoch ms
  // 최신 Player 보고 재생 위치(첫 progress 보고 전엔 null)
  progress: { currentTime: number; duration: number; ts: number } | null;
  // Player가 적용해야 할 최신 seek 명령(초기 null)
  lastSeek: { seconds: number; ts: number } | null;
  // 최신 Player 보고 재생 오류(없거나 새 곡 시도 시 null)
  playbackError: { code: number; ts: number } | null;
}

type ActivityType =
  | 'track_change' | 'volume' | 'play' | 'pause' | 'settings'
  | 'enqueue' | 'dequeue' | 'skip' | 'seek';

interface ActivityEntry {
  id: string;
  ts: number;              // epoch ms
  actor: string | null;    // null = 익명
  type: ActivityType;
  reason: string | null;
  detail?: Record<string, unknown>;
}
```

## 재생 큐 (queue / playlist)

방은 단일 `currentTrack` 외에 **재생 큐**(`RoomState.queue: Track[]`)를 가진다. 큐는 `currentTrack` **다음에** 순서대로 재생될 대기 곡 목록이며, 맨 앞(index 0)이 다음 곡이다.

| 동작 | 발행자 | 사유 | 효과 |
| --- | --- | --- | --- |
| `enqueueTrack` | Controller | **선택** | url 파싱 → `Track {id,url,title,addedBy}` 를 큐 끝에 추가. activity `enqueue`, detail `{id,url,title}` |
| `removeQueued` | Controller | **선택** | `index` 위치의 곡 제거(범위 밖이면 `invalid index`). activity `dequeue`, detail `{index}` |
| `nextTrack` | Controller | **선택** | 큐 맨 앞 곡을 `currentTrack` 으로 승격하고 큐에서 제거, `isPlaying:true`. 큐가 비어있으면 no-op `{ok:true}`. activity `skip`, detail `{id}` |
| `trackEnded` | **Player 전용** | 없음 | 플레이어가 현재 곡 종료를 보고. 자동 next처럼 동작 — 큐 있으면 승격(activity `skip`, detail `{auto:true}`), 비어있으면 `isPlaying:false` |

- **사유 정책**: `enqueueTrack` / `nextTrack` / `trackEnded` 의 사유는 **선택**이다(비면 `reason: null` 로 기록). 반면 **`changeTrack` 은 사유 필수**(`validateReason`)이며, `currentTrack` 만 설정하고 **큐를 건드리지 않는다** — 큐 모델과 독립적이다.
- **제목 자동 채움(YouTube oEmbed)**: `changeTrack` / `enqueueTrack` 에서 `title` 이 생략되면(빈/미지정) 서버는 먼저 `title: null` 로 즉시 적용·브로드캐스트(스내피한 ack/broadcast 유지)한 뒤, **비동기**로 YouTube oEmbed(`https://www.youtube.com/oembed?url=...&format=json`, 3s 타임아웃)에서 제목을 best-effort 로 조회한다. 성공 시 해당 곡(아직 `title` 이 비어있는 `currentTrack`/큐 항목)에 제목을 채우고 **재브로드캐스트**한다. 실패/타임아웃/오류 시 `null` 로 두며 절대 곡 변경을 막지 않는다(fire-and-forget). 이미 제공된 non-null `title` 은 덮어쓰지 않는다.
- **`trackEnded` 는 Player 전용**이다: controller가 발행하면 ack `{ ok:false, error:'player only' }`. 그 외 큐 제어 이벤트는 모두 Controller 전용이다.
- 신규 방은 `queue: []` 로 시작한다.

## 탐색(Seek) / 진행상황(Progress)

방은 재생 위치 관련 두 필드를 가진다: `RoomState.progress`(Player가 보고한 현재 위치)와
`RoomState.lastSeek`(Player가 적용해야 할 최신 탐색 명령). 신규 방은 둘 다 `null` 로 시작한다.

| 동작 | 발행자 | 사유 | 효과 |
| --- | --- | --- | --- |
| `seekTo` | **Controller 전용** | **선택** | `seconds` 가 유한수 `>= 0` 인지 검증(아니면 `invalid seconds`). `lastSeek = { seconds, ts }` 로 갱신, activity `seek`, detail `{seconds}`, 브로드캐스트 |
| `progress` | **Player 전용** | 없음 | `currentTime`/`duration` 이 유한수 `>= 0` 인지 검증(아니면 `invalid progress`). `progress = { currentTime, duration, ts }` 로 갱신 + 브로드캐스트 |

- **`progress` 는 Player 전용**이며 **Activity Log에 기록하지 않는다** — 고빈도 보고이므로 로그를 오염시키지 않는다(Player는 ~2s로 throttle). controller가 발행하면 ack `{ ok:false, error:'player only' }`.
- **`seekTo` 는 Controller 전용**이며 사유는 선택(비면 `reason: null`). player가 발행하면 ack `{ ok:false, error:'controllers only' }`.
- Player는 수신한 `state.lastSeek` 를 보고 해당 위치로 탐색을 적용한다.
- 매 `progress` 보고는 `stateVersion` 을 증가시키고 `state` 를 브로드캐스트한다(허용 — Player가 throttle).

## 재생 오류(Playback Error) / 복구

방은 `RoomState.playbackError`(Player가 보고한 최신 YouTube 재생 오류)를 가진다. 신규 방은 `null` 로 시작한다.

| 동작 | 발행자 | 사유 | 효과 |
| --- | --- | --- | --- |
| `playbackError` | **Player 전용** | 없음 | `code` 가 유한수인지 검증(아니면 `invalid code`). `playbackError = { code, ts }` 로 갱신 + 브로드캐스트 |

- **`playbackError` 는 Player 전용**이며 **Activity Log에 기록하지 않는다** — `progress` 와 동일하게 **상태(`RoomState.playbackError`)로만** 노출되는 status 다. controller가 발행하면 ack `{ ok:false, error:'player only' }`.
- **새 곡 시도 시 초기화**: `changeTrack`, `nextTrack`(큐 승격 시), `trackEnded`(다음 곡 승격 시) 의 `patchState` 에서 `playbackError: null` 로 비운다. 그 외에서는 비우지 않는다.
- **Player UI**: onError 발생 시 코드별 한국어 메시지 + "다시 시도" 버튼(`loadVideoById` 재시도) 배너를 띄우고, 정상 재생(`PLAYING`) 시 배너를 지운다.
- **Controller UI**: `state.playbackError` 가 있으면 now-playing 근처에 "⚠ Player 재생 오류 (코드 {code})" 경고를 표시한다.

## 검증 규칙

| 대상 | 규칙 | 위반 시 |
| --- | --- | --- |
| 곡 변경 사유 | `validateReason(reason)` = trim 후 비어있지 않음 | ack `{ ok:false, error:'reason required' }` |
| 곡 URL | `parseYouTubeId(url)` 가 video id 반환(비-null) | ack `{ ok:false, error:'invalid youtube url' }` |
| 음량 | `clampVolume(v)` = 반올림 후 0..100 클램프 | 자동 보정(에러 아님) |
| 제어 권한 | role === `'controller'` | Player가 발행 시 ack `{ ok:false }` |
| 그 외 사유 | 선택 — 비어있으면 `reason: null` 로 기록 | — |
| 익명 콘텐츠 제한 | `settings.allowAnonymous === false` 인 방에서, **콘텐츠 액션**(`changeTrack`/`enqueueTrack`/`nextTrack`)은 닉네임 없는 소켓에서 거부. 권한(컨트롤러) 검사 통과 후 적용 | ack `{ ok:false, error:'nickname required' }` |
| 방 비밀번호 | 방에 비밀번호가 있으면 `join.password` 가 일치해야 함 | ack `{ ok:false, error:'wrong password' }` |
| 입력 길이 | `withinLimit(s, LIMITS.*)` — reason 500 / url 2048 / title 200 / nickname 40 / password 64 | ack `{ ok:false, error:'... too long' }` |

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

## 설정 (RoomSettings / allowAnonymous)

방은 `RoomState.settings: RoomSettings` 를 가진다. 현재 필드는 `allowAnonymous: boolean`
(신규 방 기본값 `true`)이며 확장 가능하다.

- **변경**: `updateSettings { settings: Partial<RoomSettings> }` (Controller 전용). 기존 설정에
  **부분 병합**하고, `state` 브로드캐스트 + `'settings'` activity 1건(detail = 전달된 `settings`)을 남긴다.
- **익명 콘텐츠 제한**: `allowAnonymous === false` 이면 **콘텐츠 액션**(`changeTrack`/`enqueueTrack`/`nextTrack`)은
  **닉네임 없는 소켓**에서 `{ ok:false, error:'nickname required' }` 로 거부된다(권한 검사 통과 후 적용).
- **게이트 제외(잠금 방지)**: `updateSettings`, `setVolume`, `togglePlay`, `seekTo`, `trackEnded`,
  `progress` 는 제한하지 않는다. 특히 `updateSettings` 는 항상 열려 있어, 닉네임이 없어도 설정을
  되돌릴 수 있으므로 방이 스스로 잠기는 일이 없다. 저위험 제어(`setVolume`/`togglePlay`/`seekTo`)도 계속 열려 있다.
- **Controller UI**: `/controller` 의 **설정 섹션**에 "익명 허용 (allowAnonymous)" 체크박스를 둔다.
  변경 시 `updateSettings({ allowAnonymous })` 를 호출하고, `false` 일 때
  "닉네임이 있어야 곡을 변경할 수 있어요" 힌트를 표시한다.

## 페어링(룸 코드) 규칙

- 형식: **6자 대문자** 룸 코드.
- charset: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — 혼동되는 문자(I, O, 0, 1 등) 제외.
- `generateRoomCode()` 가 위 charset에서 6자를 무작위 생성.
- QR 코드는 추후 add-on(룸 코드를 인코딩).

## 보안 — 선택적 방 비밀번호

- 방은 **선택적으로 비밀번호**를 가질 수 있다(설정하거나 생략 가능).
- 방은 첫 `join` 시 생성되며, **최초 생성자**가 `join.password` 로 비밀번호를 설정한다(없으면 공개 방).
  - 생성 시 `password` 가 비어있으면 → 공개 방(비밀번호 없음).
  - 생성 시 `password` 가 있으면 → 그 값(trim)이 방 비밀번호가 된다.
- 비밀번호가 설정된 **기존 방**에 입장할 때:
  - `join.password` 가 방 비밀번호와 일치해야 한다 → 불일치/누락 시 ack `{ ok:false, error:'wrong password' }`.
- 비밀번호가 없는 방은 `join.password` 를 무시하고 자유 입장.
- 비밀번호는 **서버에만 보관**하며 `RoomState` 등으로 **절대 브로드캐스트하지 않는다**.
- 길이 제한: `LIMITS.password = 64`.
- Player/Controller 모두 동일 규칙 적용(방 단위 비밀번호).

## 권한 규칙 (누가 무엇을)

| 동작 | Player | Controller |
| --- | --- | --- |
| `join` | O | O |
| `state`/`activity`/`activityLog` 수신 | O | O |
| `changeTrack` | X | O |
| `setVolume` | X | O |
| `togglePlay` | X | O |
| `updateSettings` | X | O |
| `enqueueTrack` | X | O |
| `removeQueued` | X | O |
| `nextTrack` | X | O |
| `trackEnded` | **O** | X |
| `seekTo` | X | O |
| `progress` | **O** | X |
| `playbackError` | **O** | X |

## 비범위 (추후)

- 본격 인증/세션 정책(현재는 익명 + 선택 닉네임 + 선택적 방 비밀번호)
- QR 코드 페어링
- 영속 저장소(SQLite/Postgres) — 현재는 인메모리
- 사용자 강퇴/방장 권한
