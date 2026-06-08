# SPEC — remote-dj 제품/프로토콜 명세

이 문서는 remote-dj의 **계약(contract)** 을 정의한다. 여기 적힌 이벤트/타입/검증 규칙은 클라이언트와 서버가 동일하게 따라야 하는 단일 진실 공급원이다.

## 개요

remote-dj는 협업형 음악 컨트롤러다. 한 대의 **Player** 폰이 YouTube로 음악을 재생하고, 여러 대의 **Controller** 폰이 실시간으로 곡/음량/설정을 원격 조작한다. 모든 조작은 **Activity Log** 에 기록된다. 곡 변경에는 **사유(reason)가 필수**이며, 그 외 조작의 사유는 선택이다. 사용자는 **기본 익명**이며, 닉네임은 선택적으로 입력할 수 있다.

## 역할 정의

```ts
type Role = 'player' | 'controller';
```

권한 모델은 **MAIN(Player) vs GUEST(Controller)** 이다. **Player 가 메인 제어면(main control surface)** 이며 모든 제어 이벤트를 발행할 수 있다. **Controller 는 제한된 게스트(리모컨)** 로, 게스트-허용 이벤트만 발행할 수 있다.

| 역할 | 권한 | 비고 |
| --- | --- | --- |
| **Player (MAIN)** | `join` + **모든 제어 이벤트** (게스트-허용 이벤트 + 메인-전용 이벤트 + 상태 보고) | YouTube 재생을 위해 YouTube 로그인 선행 필요. 메인 제어면이며 디바이스/운영 설정(예약/모드/탐색/설정)을 소유 |
| **Controller (GUEST)** | `join` + **게스트-허용 이벤트만** (`changeTrack`/`enqueueTrack`/`setVolume`/`togglePlay`/`setTrackGain`) + 소유권 한정 `removeQueued` | 제한된 리모컨. 메인-전용 이벤트 발행 시 `{ ok:false, error:'player only' }` |

## 화면별 명세

### Landing `/`
- 역할 선택(Player / Controller)
- 방 코드 입력 또는 신규 생성
- 닉네임 입력(선택)
- 선택에 따라 `/player?room=CODE` 또는 `/controller?room=CODE` 로 이동

### Player `/player?room=CODE` (MAIN)
- YouTube **IFrame Player API** 로 실제 재생. 모바일 음소거 자동재생을 위해 음량 적용 시 `mute`/`unMute` 조정
- 서버에서 받은 `state` 를 그대로 적용(playlist[currentIndex] / isPlaying / volume)
- **단일 재생목록**: 재생함(흐릿·작게) → 현재곡(굵게·크게) → 다음 곡(작게)을 한 리스트로. **행 탭 → 그 곡으로 점프(jumpTo, 메인 전용)**, 행 ✕ → 삭제. 상단 **반복 아이콘**(색상 off/all/one) + **셔플 아이콘**(shuffleQueue) + **다음 곡**
- **곡 추가**는 드물어 **기본 접힌** 섹션. **곡 변경 폼·탐색(seek) 슬라이더는 없음**(곡 교체는 행 탭/다음곡으로)
- 메인-전용 이벤트(다음곡/jumpTo/제거/반복/셔플(shuffleQueue)/탐색(seekTo,프로토콜만)/설정/예약) 발행 가능

### Controller `/controller?room=CODE` (GUEST / 리모컨)
- **이름 설정/변경 바**: 닉네임을 정하거나 바꿀 수 있음. **첫 입장 시 "형용사 + 사물명사" 랜덤 기본값**(예: "졸린 주전자") 자동 지정 — 비우고 입장하면 익명. 익명이 막힌 방에서도 이름을 넣어 곡 추가 가능
- **시각적 음량 슬라이더**(채워지는 트랙)·**곡별 게인**, **재생/일시정지**
- **곡 추가(enqueue)**: **URL만** 입력(사유 없음, 제목은 서버가 YouTube 에서 자동 채움)
- **단일 재생목록**: 재생함(흐릿) → 현재곡(굵게) → 다음 곡. **본인이 추가한 곡만 ✕**(삭제 시 **확인 다이얼로그**). 게스트는 행 탭 점프 불가(삭제만)
- **Activity Log 피드**: 신규 항목 실시간 추가. **리모컨은 최근 5시간만 표시**(서버는 전체 보관)
- **곡 변경 폼은 없음**(메인 전용). 메인-전용 이벤트(다음곡/반복/셔플/탐색/설정/예약/즉시재생)는 **노출하지 않음**

## WebSocket 프로토콜

전송 계층은 **Socket.IO**. 모든 Client→Server 이벤트는 **ack 콜백** 을 가지며 `{ ok: boolean; error?: string }` 를 반환한다. **게스트-허용 이벤트**(`changeTrack`/`enqueueTrack`/`setVolume`/`togglePlay`/`setTrackGain`)는 **Player·Controller 둘 다** 발행할 수 있고, **메인-전용 이벤트**(`nextTrack`/`jumpTo`/`setRepeat`/`shuffleQueue`/`seekTo`/`updateSettings`/`setSchedule`)는 **Player(메인)만** 발행할 수 있다(Controller가 발행 시 ack `{ ok:false, error:'player only' }`). `removeQueued` 는 멤버가 발행하되 **소유권**으로 제한된다.

### 이벤트 표

| 이름 | 방향 | 페이로드 | ack / 결과 |
| --- | --- | --- | --- |
| `join` | C→S | `{ roomCode: string; role: Role; nickname?: string; password?: string }` | `{ ok, error? }`; 성공 시 해당 소켓에 `state` + `activityLog` 전송. 방에 비밀번호가 설정돼 있으면 일치해야 함(아래 보안 규칙) |
| `changeTrack` | C→S | `{ url: string; reason: string; title?: string }` | reason이 trim 후 빈 문자열이면 `{ ok:false, error }`; url에서 video id 파싱 실패 시 `{ ok:false, error }`; **임베드 불가/이용 불가 영상은 추가 시점에 거부** `{ ok:false, error:'embed disabled' }`(oEmbed 401/404, best-effort/fail-open). 새 Track을 **playlist 끝에 추가하고 커서를 그 곡으로 점프**(`isPlaying:true`). activity `track_change` |
| `setVolume` | C→S | `{ volume: number; reason?: string }` | 서버가 `clampVolume` 으로 0..100 정수 보정 후 적용 |
| `togglePlay` | C→S | `{ isPlaying: boolean; reason?: string }` | activity는 `play` 또는 `pause` 로 기록 |
| `updateSettings` | C→S | `{ settings: Partial<RoomSettings>; reason?: string }` | **Player 전용(메인)**(controller가 발행 시 `{ ok:false, error:'player only' }`). 부분 병합 |
| `enqueueTrack` | C→S | `{ url: string; reason?: string; title?: string }` | url 파싱 실패 시 `{ ok:false, error:'invalid youtube url' }`; **임베드 불가 영상 거부** `{ ok:false, error:'embed disabled' }`(oEmbed 401/404). **사유 선택**. playlist 끝에 추가; **IDLE(`currentIndex < 0`)이면 그 곡(index 0)을 즉시 재생**. activity `enqueue` |
| `removeQueued` | C→S | `{ index: number; reason?: string }` | playlist[index] 제거. **멤버**가 발행하되 **소유권** 제한: `index` 가 `[0, playlist.length)` 정수가 아니면 `{ ok:false, error:'invalid index' }`. **Player는 어떤 곡이든**, Controller는 **자신이 추가한 곡만**(`ownerId` 일치 또는 닉네임+`addedBy` 일치) — 아니면 `{ ok:false, error:'not your item' }`. 커서 보정(index<cur→cur-1; index===cur→다음 곡이 슬라이드인/끝이면 한 칸 당김, 비면 -1+정지). activity `dequeue`, detail `{index,id,title}` |
| `jumpTo` | C→S | `{ index: number; reason?: string }` | **Player 전용(메인)**(controller가 발행 시 `{ ok:false, error:'player only' }`). 행 탭 = 그 곡으로 커서 점프. 범위 밖이면 `{ ok:false, error:'invalid index' }`. `currentIndex=index`, `isPlaying:true`, `playbackError:null`. activity `track_change`, detail `{id,url,title}` |
| `nextTrack` | C→S | `{ reason?: string }` | **Player 전용(메인)**(controller가 발행 시 `{ ok:false, error:'player only' }`). 커서를 앞으로(advance). 커서가 끝이고 repeat≠'all' 이면 `{ ok:true }` no-op. activity `skip`. **사유 선택** |
| `trackEnded` | C→S | `{}` | **Player 전용**(controller가 발행 시 `{ ok:false, error:'player only' }`). repeat 'one' 이면 현재곡 재시작(lastSeek 0), 아니면 advance(activity `skip`, detail `{auto:true}`) |
| `seekTo` | C→S | `{ seconds: number; reason?: string }` | **Player 전용(메인)**(controller가 발행 시 `{ ok:false, error:'player only' }`). `seconds` 가 유한수 `>= 0` 가 아니면 `{ ok:false, error:'invalid seconds' }`. `lastSeek` 갱신, activity `seek`, detail `{seconds}`. **사유 선택** |
| `progress` | C→S | `{ currentTime: number; duration: number }` | **Player 전용**(controller가 발행 시 `{ ok:false, error:'player only' }`). `currentTime`/`duration` 이 유한수 `>= 0` 가 아니면 `{ ok:false, error:'invalid progress' }`. `progress` 갱신 + 브로드캐스트. **로그 기록 안 함**(고빈도) |
| `playbackError` | C→S | `{ code: number; id?: string }` | **Player 전용**(controller가 발행 시 `{ ok:false, error:'player only' }`). `code` 가 유한수가 아니면 `{ ok:false, error:'invalid code' }`. **`id`(실패한 videoId)가 현재 곡과 다르면 stale 로 보고 무시**(점프/교체 직후 늦게 온 오류가 엉뚱한 곡을 건너뛰지 않게). 유효하면 activity `error` 기록 후 **앞에 곡이 있으면 advance**(반복 'all' 래핑 안 함 — 단일 곡 무한 오류 방지); 없으면 `isPlaying:false` + `playbackError = { code, ts, id }` |
| `setTrackGain` | C→S | `{ videoId: string; gain: number; reason?: string }` | **게스트-허용(Player·Controller 둘 다)**. `videoId` 가 비어있지 않은 문자열이 아니면 `{ ok:false, error:'invalid videoId' }`. `clampGain(gain)` 으로 `[0.2, 1.0]` 보정 후 `trackGain[videoId]` 에 설정, activity `gain`, detail `{videoId, gain}`, 브로드캐스트. **사유 선택** |
| `setRepeat` | C→S | `{ mode: 'off'\|'one'\|'all'; reason?: string }` | **Player 전용(메인)**(controller가 발행 시 `{ ok:false, error:'player only' }`). `mode` 가 `off`/`one`/`all` 이 아니면 `{ ok:false, error:'invalid mode' }`. `repeat` 갱신, activity `mode`, detail `{repeat}`, 브로드캐스트. **사유 선택** |
| `shuffleQueue` | C→S | `{ reason?: string }` | **Player 전용(메인)**(controller가 발행 시 `{ ok:false, error:'player only' }`). **일회성**: 앞으로 재생될 항목(`playlist.slice(currentIndex+1)`)만 무작위 재정렬. 재생함+현재곡은 그대로. 앞으로 재생할 곡이 2개 미만이면 no-op `{ok:true}`. activity `mode`, detail `{shuffledQueue:true}` |
| `setSchedule` | C→S | `{ schedule: WeeklySchedule \| null; reason?: string }` | **Player 전용**(예약은 디바이스/운영 설정 — controller가 발행 시 `{ ok:false, error:'player only' }`). `schedule` 가 `null` 이면 예약 해제. 아니면 검증(`enabled` boolean, 7개 요일 키, 각 `on` boolean + `isHHMM(start)`/`isHHMM(end)` + `start < end`) — 실패 시 `{ ok:false, error:'invalid schedule' }`. `schedule` 갱신, activity `schedule`(detail `{enabled}`), 브로드캐스트. **사유 선택** |
| `state` | S→C | `RoomState` | join 직후 + 모든 변경 후 브로드캐스트 |
| `activity` | S→C | `ActivityEntry` | 신규 항목 1건 |
| `activityLog` | S→C | `ActivityEntry[]` | join 직후 전체 로그 |

위 게스트-허용 이벤트(`changeTrack`/`enqueueTrack`/`setVolume`/`togglePlay`/`setTrackGain`)는 Player·Controller 둘 다 발행할 수 있다.

데이터 흐름: 멤버(Player 또는 Controller)가 제어 이벤트 발행 → 서버가 검증(역할/권한) → 권위 상태(RoomState) 갱신 → 방 전체에 `state` 브로드캐스트 + 신규 `activity` 브로드캐스트.

## 데이터 타입

```ts
type Role = 'player' | 'controller';

interface Track {
  id: string;            // YouTube video id
  url: string;
  title: string | null;
  addedBy: string | null; // null = 익명 (표시용 닉네임)
  addedAt: number;        // 추가된 시각(epoch ms)
  ownerId: string;        // 추가한 연결의 불투명 id (소유권 검사용)
}

interface RoomSettings {
  allowAnonymous: boolean; // 확장 가능
}

interface RoomState {
  roomCode: string;
  // 단일 재생목록 + 커서. currentIndex 이전=재생함, currentIndex=현재곡, 이후=다음 곡.
  playlist: Track[];
  currentIndex: number;    // playlist 커서. 비었거나 시작 전이면 -1
  blockedIds: string[];    // 재생 불가(임베드 비활성)로 학습된 videoId들. 목록에 "재생 불가" 표시 + advance가 스킵
  isPlaying: boolean;
  volume: number;          // 0-100
  repeat: 'off' | 'one' | 'all'; // 반복 모드(기본 'off')
  settings: RoomSettings;
  presence: { playerConnected: boolean; controllers: number };
  updatedAt: number;       // epoch ms
  // 최신 Player 보고 재생 위치(첫 progress 보고 전엔 null)
  progress: { currentTime: number; duration: number; ts: number } | null;
  // Player가 적용해야 할 최신 seek 명령(초기 null)
  lastSeek: { seconds: number; ts: number } | null;
  // 최신 Player 보고 재생 오류(없거나 새 곡 시도 시 null)
  playbackError: { code: number; ts: number } | null;
  // 곡별 음량 정규화 게인: videoId → 감쇠 계수 [0.2, 1.0]. 없으면 1.0(변경 없음).
  // setVolume 이 100 을 넘지 못하므로 감쇠(≤1)만 가능. 방 전체 공유.
  trackGain: Record<string, number>;
  // 주간 자동 재생/종료 예약(없으면 null). 서버 로컬 타임존 기준.
  schedule: WeeklySchedule | null;
}

type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

interface DaySchedule {
  on: boolean;
  start: string; // "HH:MM" (24h)
  end: string;   // "HH:MM" (24h)
}

interface WeeklySchedule {
  enabled: boolean;
  days: Record<DayKey, DaySchedule>;
}

type ActivityType =
  | 'track_change' | 'volume' | 'play' | 'pause' | 'settings'
  | 'enqueue' | 'dequeue' | 'skip' | 'seek' | 'gain' | 'mode' | 'schedule' | 'error';

interface ActivityEntry {
  id: string;
  ts: number;              // epoch ms
  actor: string | null;    // null = 익명
  type: ActivityType;
  reason: string | null;
  detail?: Record<string, unknown>;
}
```

## 재생목록 (playlist + cursor)

방은 **단일 재생목록**(`RoomState.playlist: Track[]`)과 **커서**(`RoomState.currentIndex`)를 가진다.
`currentIndex` **이전** 항목 = 이미 재생함, `currentIndex` = 현재 곡, **이후** = 다음 곡들.
빈 방/시작 전이면 `currentIndex = -1`. 곡은 칸 사이를 이동하지 않고 **리스트에 그대로 남으며**, 커서만
움직인다 — 그래서 반복(all)이 "리스트를 그대로 다시 돈다"로 자연스럽게 보인다.

| 동작 | 발행자 | 사유 | 효과 |
| --- | --- | --- | --- |
| `changeTrack` | **게스트-허용** | **필수** | 새 `Track` 을 playlist 끝에 추가하고 **커서를 그 곡으로 점프**(`isPlaying:true`, `playbackError:null`). activity `track_change` |
| `enqueueTrack` | **게스트-허용** | **선택** | `Track` 를 playlist 끝에 추가. **IDLE(`currentIndex < 0`)이면 그 곡(index 0)을 즉시 재생**(`isPlaying:true`). activity `enqueue`, detail `{id,url,title}` |
| `jumpTo` | **Player 전용(메인)** | **선택** | 행 탭 = `currentIndex=index` 로 점프 재생(`isPlaying:true`, `playbackError:null`). 범위 밖이면 `invalid index`. activity `track_change`, detail `{id,url,title}` |
| `removeQueued` | **멤버(소유권 제한)** | **선택** | playlist[index] 제거(범위 밖이면 `invalid index`). **Player는 모든 곡, Controller는 자신이 추가한 곡만**(아니면 `not your item`). 커서 보정. activity `dequeue`, detail `{index,id,title}` |
| `nextTrack` | **Player 전용(메인)** | **선택** | 커서를 앞으로(advance). 끝이고 repeat≠'all' 이면 no-op `{ok:true}`. activity `skip`, detail `{id,title}` |
| `trackEnded` | **Player 전용** | 없음 | 현재 곡 종료 보고. repeat 'one' 이면 현재곡 재시작, 아니면 advance(activity `skip`, detail `{auto:true}`) |

- **사유 정책**: `changeTrack` 은 사유 **필수**(`validateReason`). `enqueueTrack`/`jumpTo`/`nextTrack`/`trackEnded` 등은 **선택**(비면 `reason: null`).
- **제목 자동 채움(YouTube oEmbed)**: `changeTrack`/`enqueueTrack` 에서 `title` 생략 시 서버는 `title: null` 로 즉시 적용·브로드캐스트한 뒤, **비동기**로 oEmbed(3s 타임아웃)에서 제목을 best-effort 조회한다. 성공 시 해당 곡(아직 `title` 이 비어있는 playlist 항목)에 제목을 채우고 **재브로드캐스트**한다. **또한 그 곡 id 로 기록됐지만 `detail.title` 이 비어있던 Activity Log 항목(예: enqueue)도 제목을 backfill 하고 전체 `activityLog` 를 재전송**한다 — 로그에 "제목 없음" 대신 실제 제목이 보인다. 실패 시 `null` 로 두며 곡 추가를 막지 않는다(fire-and-forget). non-null `title` 은 덮어쓰지 않는다.
- **임베드 가능 검사(추가 시점)**: `changeTrack`/`enqueueTrack` 에서 url 파싱 후 임베드 가능 여부를 **추가 시점에 확인**하고 불가하면 `{ ok:false, error:'embed disabled' }` 로 거부한다.
  - **(A) 확정 경로 — `YOUTUBE_API_KEY` 설정 시**: YouTube Data API `videos.list?part=status` 의 `status.embeddable` 로 판정(영상 없음/임베드 비활성 → 거부). **첫 추가에서 임베드 비활성 영상을 막을 수 있는 유일한 방법.**
  - **(B) 키 없을 때 — oEmbed(3s)**: 401/404 → 거부, 200 → 통과(단 **임베드 비활성 영상은 oEmbed가 200을 반환**해 첫 추가는 통과됨), 그 외/오류/타임아웃 → fail-open.
  - **(C) per-room 학습 차단**: Player가 재생 중 임베드 오류(코드 101/150)를 보고하면 서버는 그 `videoId` 를 **`RoomState.blockedIds`**(해당 방)에 기록한다. 이후: ① 목록 UI에 **"재생 불가"** 로 표시(흑백 썸네일·취소선, 자동 건너뜀 안내), ② `advance()` 가 그 곡을 **스킵**, ③ 같은 영상의 추가를 추가 시점에 `embed disabled` 로 거부. 방 삭제(빈 방 7일 sweep 후)되면 `blockedIds` 도 사라져 새 방에서 다시 학습.
  - **resolveEmbeddable 반환 규약**: `false`=확정 불가(Data API `status.embeddable=false`, 즉 소유자가 임베드 OFF) → 거부, `true`=Data API가 가능이라 함, `null`=알 수 없음(oEmbed 200·키 없음·오류·테스트). `decideEmbed`: `false`면 거부, **이미 blockedIds에 있으면 `true`든 `null`이든 거부(sticky)**, 그 외 허용.
  - **중요(라이선스 음악 한계)**: `status.embeddable` 은 **소유자 토글**일 뿐, 저작권/라이선스가 걸린 음악 영상은 `embeddable=true` 인데도 임베드 재생 시 150으로 막힌다. 즉 **API 키가 있어도 이런 영상은 추가 시점에 못 막고**, 오직 재생 시 150(ground truth)으로만 잡힌다. 그래서 150으로 학습한 차단은 **API `true` 로도 자동 해제하지 않는다**(해제하면 재추가→재실패 반복).
  - **임베드 다시 켜지면?**: 150-학습 차단은 **방이 재생성될 때(빈 방 7일 sweep 삭제 후) 초기화**되어 다시 시도된다(같은 방에서는 고정 유지). API 키는 **소유자가 임베드를 끈 영상**(embeddable=false)을 첫 추가에 막는 데만 확실히 유효하다.

- **빈 방 정리(sweep)**: 방은 마지막 소켓이 나간 시각(`emptySince`, 서버 전용·영속·broadcast 안 함)을 기록하고, **부팅 1회 + 1시간 주기 sweep**이 `비어있음 && now-emptySince ≥ 7일(ROOM_TTL_MS)`인 방을 삭제(라이브 소켓 재확인 통과 시). 영속 타임스탬프 기반이라 **서버 재시작에도 유지**(과거 in-memory `setTimeout` 방식은 재시작 시 소실). stamp가 없으면(크래시·레거시) sweep이 재스탬프(self-heal). **`PINNED_ROOMS`**(env, 콤마 구분, 대소문자 무시) 방은 sweep에서 영구 면제(상시 DJ홈용).
  - `REMOTE_DJ_FAKE_TITLE` 설정 시 네트워크 없이 `null`(테스트는 blocklist 동작을 검증).
- **빈 플레이어 auto-start**: `enqueueTrack` 시 `currentIndex < 0`(빈 재생목록)이면 추가한 곡(index 0)을 즉시 `currentIndex` 로 잡고 `isPlaying:true`. 이미 재생 중이면 playlist 끝에만 추가한다.
- 신규 방은 `playlist: []`, `currentIndex: -1` 로 시작한다.

## 반복/셔플/다음곡 결정 (repeat / shuffle / advance)

`RoomState.repeat`(`'off'`(기본)/`'one'`/`'all'`)는 **Player 전용(메인)** 이벤트로 바꾼다.

| 동작 | 발행자 | 사유 | 효과 |
| --- | --- | --- | --- |
| `setRepeat` | **Player 전용(메인)** | **선택** | `mode` 검증(아니면 `invalid mode`). `repeat` 갱신, activity `mode`, detail `{repeat}`. UI는 아이콘 색상으로 off/all/one 표시 |
| `shuffleQueue` | **Player 전용(메인)** | **선택** | **일회성**: 앞으로 재생될 항목(`playlist.slice(currentIndex+1)`)만 무작위 재정렬(Fisher–Yates). 재생함+현재곡은 그대로. 앞으로 재생할 곡이 2개 미만이면 no-op `{ok:true}`. activity `mode`, detail `{shuffledQueue:true}`. 유튜브 셔플 버튼과 동일 — UI는 아이콘 |

**다음곡 결정(advance)** — `nextTrack`(수동)과 `trackEnded`(자동)가 공유:
- `next = currentIndex + 1`. `next < playlist.length` 이면 그 곡으로(커서만 이동, `isPlaying:true`, `playbackError:null`, activity `skip`).
- `next >= playlist.length`(끝):
  - `repeat === 'all'`: 커서를 **0 으로 래핑**(리스트를 그대로 다시 돈다).
  - `repeat === 'off' | 'one'`: 정지(`isPlaying:false`), 커서는 마지막 곡에 유지.
- 빈 재생목록: `isPlaying:false`, `currentIndex:-1`.

**반복 'one'(현재곡 반복)**: **자동 종료(`trackEnded`)** 에서만 — `currentIndex >= 0` 이면 `lastSeek = { seconds: 0, ts }` + `isPlaying:true` 로 현재곡 재시작하고 **activity 를 남기지 않는다**. **수동 next 는 'one' 을 무시**(항상 다음 곡으로). 끝이고 `repeat !== 'all'` 이면 `{ok:true}` no-op.

**removeQueued 커서 보정**: `index < currentIndex` → `currentIndex--`; `index === currentIndex`(현재곡 삭제) → 다음 곡이 그 자리에 슬라이드인(끝이었으면 한 칸 당김, 비면 `-1`+`isPlaying:false`, `playbackError` 클리어); `index > currentIndex` → 그대로.

**playbackError 처리**: 현재 곡 오류는 activity `error` 기록 후, **앞에 곡이 있으면 advance**(반복 'all' 래핑은 **하지 않음** — 단일 곡 무한 오류 방지). 없으면 정지 + `playbackError = { code, ts, id }`.

## 탐색(Seek) / 진행상황(Progress)

방은 재생 위치 관련 두 필드를 가진다: `RoomState.progress`(Player가 보고한 현재 위치)와
`RoomState.lastSeek`(Player가 적용해야 할 최신 탐색 명령). 신규 방은 둘 다 `null` 로 시작한다.

| 동작 | 발행자 | 사유 | 효과 |
| --- | --- | --- | --- |
| `seekTo` | **Player 전용(메인)** | **선택** | `seconds` 가 유한수 `>= 0` 인지 검증(아니면 `invalid seconds`). `lastSeek = { seconds, ts }` 로 갱신, activity `seek`, detail `{seconds}`, 브로드캐스트 |
| `progress` | **Player 전용** | 없음 | `currentTime`/`duration` 이 유한수 `>= 0` 인지 검증(아니면 `invalid progress`). `progress = { currentTime, duration, ts }` 로 갱신 + 브로드캐스트 |

- **`progress` 는 Player 전용**이며 **Activity Log에 기록하지 않는다** — 고빈도 보고이므로 로그를 오염시키지 않는다(Player는 ~2s로 throttle). controller가 발행하면 ack `{ ok:false, error:'player only' }`.
- **`seekTo` 는 Player 전용(메인)**이며 사유는 선택(비면 `reason: null`). controller가 발행하면 ack `{ ok:false, error:'player only' }`.
- Player는 수신한 `state.lastSeek` 를 보고 해당 위치로 탐색을 적용한다.
- 매 `progress` 보고는 `stateVersion` 을 증가시키고 `state` 를 브로드캐스트한다(허용 — Player가 throttle).

## 재생 오류(Playback Error) / 복구

방은 `RoomState.playbackError`(Player가 보고한 최신 YouTube 재생 오류)를 가진다. 신규 방은 `null` 로 시작한다.

| 동작 | 발행자 | 사유 | 효과 |
| --- | --- | --- | --- |
| `playbackError` | **Player 전용** | 없음 | `code` 가 유한수인지 검증(아니면 `invalid code`). activity `error` 기록 후 자동으로 다음 곡으로 진행(또는 큐가 비면 정지) |

- **`playbackError` 는 Player 전용**이다. controller가 발행하면 ack `{ ok:false, error:'player only' }`.
- **자동 스킵 + 로그**: 오류가 보고되면 서버는 먼저 activity `error`(code→한국어 메시지, detail `{ code, id }`)를 **기록**한 뒤, 큐에 곡이 있으면 `advance` 로 **즉시 다음 곡으로 넘어간다**(다음 곡 승격, `isPlaying:true`, `playbackError:null`). 큐가 비어있으면 `isPlaying:false` 로 멈추고 `playbackError = { code, ts, id }` 로 오류를 유지하여 Controller UI 가 계속 노출할 수 있게 한다. 즉 잘못된 곡은 추가 조작 없이 바로 건너뛰고 사유가 Activity Log 에 남는다.
- **코드→메시지**: 2 → "잘못된 링크", 5 → "HTML5 재생 오류", 100 → "영상을 찾을 수 없음", 101/150 → "임베드가 비활성화된 영상", 그 외 → "재생 오류".
- **새 곡 시도 시 초기화**: `changeTrack`, `nextTrack`(큐 승격 시), `trackEnded`(다음 곡 승격 시), `playbackError`(자동 스킵으로 다음 곡 승격 시) 의 `patchState` 에서 `playbackError: null` 로 비운다. 그 외에서는 비우지 않는다.
- **Player UI**: onError 발생 시 코드별 한국어 메시지 + "다시 시도" 버튼(`loadVideoById` 재시도) 배너를 띄우고, 정상 재생(`PLAYING`) 시 배너를 지운다.
- **Controller UI**: `state.playbackError` 가 있으면 now-playing 근처에 "⚠ Player 재생 오류 (코드 {code})" 경고를 표시한다.

## 음량 정규화 (Loudness Normalization)

곡마다 기본 음량이 제각각이라 곡이 바뀔 때마다 체감 음량이 들쭉날쭉하다. 이를 완화하기 위해
방은 **곡별 게인**(`RoomState.trackGain: Record<videoId, number>`)을 가진다. 게인은 **감쇠 계수**로,
`[0.2, 1.0]` 범위이며 **항상 ≤ 1**이다 — YouTube `setVolume` 이 100 을 넘지 못해 **증폭이 불가능**하므로
시끄러운 곡을 **줄이는** 방향(attenuate-only)으로만 정규화한다. videoId 키가 없으면 `1.0`(변경 없음)이다.
신규 방은 `trackGain: {}` 로 시작한다.

**A) 수동 곡별 게인(`setTrackGain`)** — 게스트-허용(Player·Controller 둘 다). `{ videoId, gain, reason? }` 를 받아
`clampGain(gain)` 으로 `[0.2, 1.0]` 보정 후 `trackGain[videoId]` 에 **공유 상태**로 저장하고,
activity `gain`(detail `{videoId, gain}`)을 남긴 뒤 브로드캐스트한다. `videoId` 가 비어있지 않은
문자열이 아니면 `{ ok:false, error:'invalid videoId' }`. 사유는 선택.

**B) YouTube loudnessDb 자동 시드(auto-seed)** — `changeTrack`/`enqueueTrack` 직후, 서버는
**fire-and-forget**(제목 자동 채움과 동일 패턴)으로 해당 곡의 라우드니스를 best-effort 조회한다.
조회는 **비공식(unofficial) innertube `player` 엔드포인트**(`playerConfig.audioConfig.loudnessDb`)를
4s 타임아웃으로 POST 하며, 언제든 깨질 수 있다(문서화된 API 아님). 결과 `loudnessDb`(곡이 YouTube
기준보다 얼마나 큰지, dB)로부터 `factor = clampGain(min(1, 10^(-loudnessDb/20)))` 를 계산한다.
- **수동/기존 값 우선**: 해당 videoId 에 이미 게인이 있으면(수동 또는 이전 자동) **덮어쓰지 않는다**.
- **실패 ⇒ no-op**: 조회 실패/타임아웃/비-ok/비숫자(`null`)면 아무 것도 하지 않으며 곡 변경을 절대 막지 않는다.
- **무변화 스킵**: `factor >= 1`(감쇠 불필요)이면 저장하지 않는다.
- 자동 시드는 **activity 를 남기지 않는다**(로그 오염 방지). 결정적 테스트/QA 를 위해 환경변수
  `REMOTE_DJ_FAKE_LOUDNESS` 가 설정되면 네트워크 없이 그 값을 라우드니스로 사용한다.

**Player 적용**: Player 는 현재 곡(`playlist[currentIndex]`)에 대해
`effectiveVolume = clamp(round(volume × (trackGain[현재곡.id] ?? 1)))` 로 실제 재생 음량을 계산해
적용한다(master `volume` 은 그대로 두고 곡별로만 감쇠).

## 주간 예약(스케줄) — 자동 재생/종료

방은 선택적으로 **주간 예약**(`RoomState.schedule: WeeklySchedule | null`, 신규 방 기본 `null`)을 가진다.
요일별로 `on` 여부와 `start`/`end` 시각("HH:MM", 24h)을 지정하면, 서버가 그 시간대에 맞춰
**자동으로 재생을 시작/종료**한다. 시각은 모두 **서버 로컬 타임존** 기준이다.

예약은 **Player가 설정한다**(디바이스/운영 설정). Controller는 사운드/음악 제어 전용이며 예약 UI를 갖지 않는다.

| 동작 | 발행자 | 사유 | 효과 |
| --- | --- | --- | --- |
| `setSchedule` | **Player 전용** | **선택** | `schedule`(또는 `null`로 해제)을 검증·저장. activity `schedule`(detail `{enabled}`), 브로드캐스트 |

- **검증**(`schedule != null` 일 때): `enabled` boolean, `days` 에 7개 요일 키(`mon`..`sun`) 모두 존재,
  각 `day.on` boolean + `isHHMM(start)` + `isHHMM(end)` + `start < end`. 하나라도 위반하면
  `{ ok:false, error:'invalid schedule' }`. `null` 은 예약 해제로 항상 허용.
- **분 단위 체크**: 서버는 60초마다 현재 로컬 시각을 평가한다(`setInterval(..., 60_000)`).
  테스트/QA 는 `createServer` 가 반환하는 `tickSchedules(now)` 로 결정적인 `now` 를 주입한다.
  타이머는 `.unref()` 되어 프로세스/테스트 종료를 막지 않는다.
- **"원하는 상태"(want) 계산**: 예약이 없거나 `enabled === false` 면 **무의견(null)** — 그 방은 건드리지 않는다.
  해당 요일이 `off` 면 `false`. 켜져 있으면 `start <= 현재시각("HH:MM") < end` 이면 `true`, 아니면 `false`.
- **EDGE-triggered(가장자리 전이)**: 방마다 직전 want 를 기억해 **want 가 바뀌는 순간에만** 동작한다.
  매 분 강제로 상태를 덮어쓰지 **않는다** — 따라서 윈도우 **중간에 수동 일시정지**해도, 다음 예약
  가장자리(윈도우 시작/종료)까지는 다시 재생을 켜지 않는다(수동 제어와 싸우지 않음). 무의견(null)은
  가장자리로 기록하지 않는다.
- **시작(want `true` 이고 정지 상태)**: `currentIndex >= 0` 이면 `isPlaying:true` 로 재개,
  아니고 `playlist` 가 있으면 `currentIndex:0` 으로 첫 곡 재생, 둘 다 없으면 `isPlaying:true` 만
  세팅(무해). 그 뒤 activity `schedule`(detail `{auto:true, action:'play'}`) 기록 + 브로드캐스트.
- **종료(want `false` 이고 재생 중)**: `isPlaying:false`, activity `schedule`(detail `{auto:true, action:'stop'}`),
  브로드캐스트.
- **영속**: 예약은 `RoomState.schedule` 의 일부이므로 `PersistentRoomStore` 에 의해 **자동 저장**된다.

## 검증 규칙

| 대상 | 규칙 | 위반 시 |
| --- | --- | --- |
| 곡 변경 사유 | `validateReason(reason)` = trim 후 비어있지 않음 | ack `{ ok:false, error:'reason required' }` |
| 곡 URL | `parseYouTubeId(url)` 가 video id 반환(비-null) | ack `{ ok:false, error:'invalid youtube url' }` |
| 음량 | `clampVolume(v)` = 반올림 후 0..100 클램프 | 자동 보정(에러 아님) |
| 곡 게인 | `clampGain(g)` = 소수 2자리 반올림 후 0.2..1.0 클램프 | 자동 보정(에러 아님). `videoId` 빈 문자열은 `invalid videoId` |
| 게스트-허용 권한 | role === `'controller'` 또는 `'player'` (멤버) | 비멤버 발행 시 ack `{ ok:false, error:'not in a room' }` |
| 메인-전용 권한 | role === `'player'` | Controller가 발행 시 ack `{ ok:false, error:'player only' }` |
| 그 외 사유 | 선택 — 비어있으면 `reason: null` 로 기록 | — |
| 익명 콘텐츠 제한 | `settings.allowAnonymous === false` 인 방에서, **Controller(게스트)의 콘텐츠 액션**(`changeTrack`/`enqueueTrack`)은 닉네임 없는 소켓에서 거부. **Player(메인)는 게이트하지 않음**. 멤버십 검사 통과 후 적용 | ack `{ ok:false, error:'nickname required' }` |
| 방 비밀번호 | 방에 비밀번호가 있으면 `join.password` 가 일치해야 함 | ack `{ ok:false, error:'wrong password' }` |
| 입력 길이 | `withinLimit(s, LIMITS.*)` — reason 500 / url 2048 / title 200 / nickname 40 / password 64 | ack `{ ok:false, error:'... too long' }` |

### 공유 유틸 (packages/shared)

| 함수 | 시그니처 | 설명 |
| --- | --- | --- |
| `parseYouTubeId` | `(url: string) => string \| null` | 다양한 YouTube URL 형태에서 video id 추출, 실패 시 null |
| `validateReason` | `(r: string) => boolean` | trim 후 비어있지 않으면 true |
| `clampVolume` | `(v: number) => number` | 반올림 후 0..100 |
| `clampGain` | `(g: number) => number` | 소수 2자리 반올림 후 0.2..1.0 (감쇠 전용) |
| `generateRoomCode` | `() => string` | 6자 룸 코드 생성 |
| `isHHMM` | `(s: string) => boolean` | 유효한 24h "HH:MM"(00:00–23:59)이면 true |

## Activity Log 스키마 + 예시

각 조작은 `ActivityEntry` 1건으로 기록되어 `activity` 로 브로드캐스트되고 전체 로그는 join 시 `activityLog` 로 전달된다.

| id | ts | actor | type | reason | detail |
| --- | --- | --- | --- | --- | --- |
| a1 | 1748... | null | `track_change` | "분위기 띄우려고" | `{ title, url, id }` |
| a2 | 1748... | "철수" | `volume` | "통화 중이라 줄임" | `{ volume: 30 }` |
| a3 | 1748... | null | `pause` | null | — |
| a4 | 1748... | "영희" | `settings` | null | `{ allowAnonymous: false }` |

- **actor 규칙**: 액션을 발행한 소켓의 역할로 결정한다. **Player(메인) 액션은 `"Player"`**(닉네임이 있으면 `"Player(닉네임)"`)로 기록되고, Controller(게스트)는 `닉네임` 또는 `null`(익명)이다. `actor` 가 `null` 이면 클라이언트에서 "익명"으로 표시한다.
- `track_change` 는 항상 `reason` 이 non-null이다(검증 규칙).

## 설정 (RoomSettings / allowAnonymous)

방은 `RoomState.settings: RoomSettings` 를 가진다. 현재 필드는 `allowAnonymous: boolean`
(신규 방 기본값 `true`)이며 확장 가능하다.

- **변경**: `updateSettings { settings: Partial<RoomSettings> }` (**Player 전용(메인)** — controller가
  발행 시 `player only`). 기존 설정에 **부분 병합**하고, `state` 브로드캐스트 + `'settings'` activity
  1건(detail = 전달된 `settings`)을 남긴다.
- **익명 콘텐츠 제한**: `allowAnonymous === false` 이면 **Controller(게스트)의 콘텐츠 액션**
  (`changeTrack`/`enqueueTrack`)은 **닉네임 없는 소켓**에서 `{ ok:false, error:'nickname required' }` 로
  거부된다(멤버십 검사 통과 후 적용). **Player(메인)는 게이트하지 않는다** — 메인은 항상 곡을 바꿀 수 있다.
- **게이트 제외**: `setVolume`, `togglePlay`, `setTrackGain` 등 저위험 게스트 제어는 익명이어도
  제한하지 않는다. `updateSettings` 는 Player 전용이므로 닉네임 없는 게스트가 방을 잠글 수 없다.
- **Controller UI**: 설정 변경(예약/모드/익명 허용 등)은 **Player(메인) UI** 소관이다. Controller(리모컨)는
  게스트-허용 제어(곡 변경/큐 추가/음량/재생토글/게인)만 노출하며, `allowAnonymous === false` 일 때
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

**모델**: Player = MAIN(모든 제어), Controller = GUEST(게스트-허용 이벤트만). 메인-전용 이벤트를
Controller가 발행하면 `{ ok:false, error:'player only' }`.

| 동작 | 분류 | Player(MAIN) | Controller(GUEST) |
| --- | --- | --- | --- |
| `join` | — | O | O |
| `state`/`activity`/`activityLog` 수신 | — | O | O |
| `changeTrack` | 게스트-허용 | O | O |
| `enqueueTrack` | 게스트-허용 | O | O |
| `setVolume` | 게스트-허용 | O | O |
| `togglePlay` | 게스트-허용 | O | O |
| `setTrackGain` | 게스트-허용 | O | O |
| `nextTrack` | 메인-전용 | **O** | **X (player only)** |
| `removeQueued` | 멤버(소유권) | **O (모든 곡)** | **O (자신이 추가한 곡만, 아니면 not your item)** |
| `setRepeat` | 메인-전용 | **O** | **X (player only)** |
| `setShuffle` | 메인-전용 | **O** | **X (player only)** |
| `seekTo` | 메인-전용 | **O** | **X (player only)** |
| `updateSettings` | 메인-전용 | **O** | **X (player only)** |
| `setSchedule` | 메인-전용 | **O** | **X (player only)** |
| `trackEnded` | 상태(Player) | **O** | X |
| `progress` | 상태(Player) | **O** | X |
| `playbackError` | 상태(Player) | **O** | X |

- **익명 게이트는 Controller에만** 적용된다(`changeTrack`/`enqueueTrack`). Player(메인)는 익명이어도 게이트되지 않는다.

## 비범위 (추후)

- 본격 인증/세션 정책(현재는 익명 + 선택 닉네임 + 선택적 방 비밀번호)
- QR 코드 페어링
- 영속 저장소(SQLite/Postgres) — 현재는 인메모리
- 사용자 강퇴/방장 권한
