# remote-dj

> 여러 사람이 **한 대의 재생용 폰**에서 흐르는 YouTube 음악을 원격으로 함께 조작하는 협업형 음악 컨트롤러.

[![CI](https://github.com/monocsp/remote-dj/actions/workflows/ci.yml/badge.svg)](https://github.com/monocsp/remote-dj/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19-149eca?logo=react)](https://react.dev/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-4-010101?logo=socket.io)](https://socket.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-22%2B-5FA04E?logo=node.js)](https://nodejs.org/)

카페·사무실·라운지처럼 **스피커에 연결된 폰 한 대**를 여러 사람이 같이 쓰는 상황을 위한 도구다.
곡은 YouTube 링크로 추가하고 곡을 바꾸거나 음량을 조절할 때 **사유(메모)** 를 남길 수 있어
"왜 이 곡으로 바꿨는지 / 왜 소리를 줄였는지"를 다른 사람이 확인할 수 있다.
서버는 셀프호스트(컴퓨터 또는 안드로이드 Termux)로 누구나 포크해 돌릴 수 있다.

![demo](docs/demo.gif)
<!-- [TODO] 데모 GIF/스크린샷 추가 (랜딩 → 방 입장 → 곡 변경 → 실시간 동기화가 보이도록) -->

## ✨ Features

- **실시간 협업 제어** — 하나의 Player 폰에 여러 Controller가 접속해 곡 변경·음량·재생/일시정지를 동시에 조작. 서버가 권위 상태를 쥐고 전원에게 브로드캐스트한다.
- **곡 변경 + 사유** — 재생 곡을 바꿀 때는 **사유 입력이 필수**. 음량·설정 변경은 익명이 기본이며 사유는 선택.
- **YouTube 기반 재생** — Player 폰 브라우저의 **YouTube IFrame Player API** 로 재생. 링크는 `youtu.be` / `watch?v=` / `embed` / `shorts` / `music.youtube.com` 형태를 파싱한다.
- **재생 큐 + 재생 모드** — 순서 있는 단일 플레이리스트 + 커서. 다음 곡(수동/자동), 특정 곡으로 점프, 반복(off/one/all), 예정 곡만 셔플.
- **Seek(진행바)** — Controller가 절대 위치로 이동 요청, Player가 반영.
- **음량 정규화(로드니스)** — 곡별 감쇠 게인. YouTube의 `loudnessDb` 를 best-effort로 읽어 자동 시드하며 수동 설정이 항상 우선한다.
- **재생 불가 영상 학습** — 임베드가 막힌 영상은 재생 오류를 근거로 방별 blocklist에 기록하고 자동 스킵. (`YOUTUBE_API_KEY` 가 있으면 추가 시점에 미리 차단.)
- **주간 자동 재생 예약** — 요일·시간대를 정하면 서버가 그 시간에 맞춰 자동으로 켜고 끈다. 평가는 **한국시간(Asia/Seoul)** 기준.
- **한국 공휴일 스킵(선택)** — 예약에서 켜면 공휴일(대체공휴일 포함)에는 자동 재생을 건너뛴다. 번들 정적 목록 기본 + `data.go.kr`(KASI) API 선택 보강.
- **방 코드 + 선택 비밀번호** — 혼동 없는 6자 코드로 페어링. 첫 입장자가 방 비밀번호를 정할 수 있다.
- **익명 / 닉네임** — 기본 익명, 선택 닉네임. 방 설정 `allowAnonymous` 를 끄면 곡 추가 시 닉네임을 강제한다.
- **변경 이력(Activity Log)** — 모든 조작을 시각·행위자·종류·사유와 함께 기록해 전원에게 공유.
- **포크 친화 실행** — 클라이언트가 서버 URL을 **런타임에 자동 계산**(같은 호스트, 웹 포트+1)하므로 LAN에서는 재빌드 없이 접속된다.

## 🛠 Tech Stack / 아키텍처

npm workspaces 모노레포. 서버가 **권위 상태(authoritative state)** 를 단독 보유하고 클라이언트는 낙관적 추측 없이 서버가 브로드캐스트하는 `state` 를 그대로 반영한다.

| 워크스페이스 | 역할 | 주요 스택 |
| --- | --- | --- |
| `packages/shared` | WebSocket 프로토콜의 단일 진실 소스 — 이벤트 상수(`C2S`/`S2C`), 타입, 유틸. **단일 파일**(`src/index.ts`)이라 내부 상대 import이 없다. | TypeScript 5 |
| `apps/server` | 권위 서버. 이벤트 검증·룸 상태 관리·브로드캐스트·Activity Log·스케줄러. | Node 22+, Socket.IO 4.8, nanoid |
| `apps/web` | 모바일 우선 반응형 웹. Landing / Player / Controller 화면. Player는 YouTube IFrame API 사용. | Next.js 15(App Router), React 19, Tailwind, socket.io-client, zustand |

**동기화 모델**

```
   Controller A ─┐  changeTrack / setVolume / ...  (ack 콜백)
   Controller B ─┤
   Controller C ─┘
        │
        ▼
   ┌──────────────────────────────┐
   │        Socket.IO Server        │
   │  1. role / payload 검증        │
   │  2. RoomState 갱신 (권위)      │
   │  3. ActivityEntry 생성         │
   └──────────────────────────────┘
        │  broadcast(room)
        ├──────────────►  state    (RoomState 전체)  → 전원
        └──────────────►  activity (1건)             → 전원
        │
        ▼
   Player 폰 ── state 적용 ──► YouTube IFrame (재생 / 음량 / 곡)
```

- 검증 실패 시 상태·로그를 바꾸지 않고 **ack로만 에러를 반환**한다.
- `join` 시 해당 소켓에 현재 `state` + 전체 `activityLog` 를 1회 전송한다.

코드에서 눈여겨볼 구현:

- **`stateVersion`** — 모든 패치마다 증가하는 단조 카운터. 보이는 필드가 안 바뀌는 브로드캐스트(예: 1곡 플레이리스트의 repeat-all 랩)도 클라이언트가 감지/재동기화할 수 있다.
- **엣지 트리거 스케줄러** — 주간 예약은 원하는 상태가 **바뀌는 순간에만** 동작한다. 창(window) 중간의 수동 일시정지를 다음 엣지까지 다시 덮어쓰지 않아 자동/수동이 충돌하지 않는다.
- **방별 재생불가 학습** — 임베드 차단(오류 101/150)은 방 상태 `blockedIds` 에 남아 목록에 표시되고 advance에서 스킵된다.
- **YouTube 메타데이터 보강** — 제목은 공개 oEmbed로, 로드니스는 비공식 innertube 엔드포인트로 best-effort 조회(실패해도 무해). 게인은 감쇠 전용(≤ 1.0).
- **교체 가능한 RoomStore** — `InMemoryRoomStore` 인터페이스 뒤에 있고 운영은 JSON 파일 영속 구현(`PersistentRoomStore`, 기본 `apps/server/.data/rooms.json`)을 쓴다. 재시작해도 방/로그가 유지된다.
- **빈 방 청소(sweep)** — 비어 있는 방을 TTL(7일) 뒤 삭제. 타임스탬프를 레코드에 저장해 재시작에도 안전하며 `PINNED_ROOMS` 는 예외.
- **프로토콜 계약 내보내기** — `npm run contract:export` 가 `qa/contract.json` 을 생성. Python 블랙박스 하네스는 TS를 import하지 않고 이 계약만 읽어 테스터가 구현에 동조(drift)되는 걸 막는다.

## 🚀 Getting Started

**요구 사항**: Node.js 22+

```bash
git clone https://github.com/monocsp/remote-dj.git
cd remote-dj
npm install
npm run dev          # 서버(:3001) + 웹(:3000) 동시 기동
```

- 실행한 컴퓨터에서는 `http://localhost:3000` 으로 접속.
- 같은 Wi-Fi의 다른 폰에서는 `http://<이 컴퓨터의 LAN IP>:3000` 으로 접속. 클라이언트가 서버 URL을 런타임에 계산(웹 포트+1)하므로 **LAN에서는 재빌드가 필요 없다**.
- 서버가 파생 불가한 곳(리버스 프록시/공개 터널 등)에 있으면 `NEXT_PUBLIC_SERVER_URL` 을 지정해 web을 빌드한다.

**역할별 진입**

| 역할 | 설명 | 진입 |
| --- | --- | --- |
| **Player (재생용 폰, 메인)** | 실제로 음악을 재생. 재생하려면 **YouTube 로그인 선행** 필요. | `/player?room=<코드>` |
| **Controller (조작 유저들)** | 여러 명이 동시에 접속해 곡 변경·음량·설정. 휴대폰 화면 기준 반응형. | `/controller?room=<코드>` |

랜딩(`/`)에서 역할·방 코드·(선택) 비밀번호·닉네임을 입력하면 위 경로로 이동한다.

**환경 변수** (`apps/server/.env`, gitignore 대상 — `apps/server/.env.example` 참고)

| 변수 | 기본 | 설명 |
| --- | --- | --- |
| `PORT` / `HOSTNAME` | `3001` / `0.0.0.0` | 서버 포트·바인드 인터페이스 |
| `CORS_ORIGIN` | `*` | 허용 Origin |
| `PINNED_ROOMS` | — | 빈 방 청소에서 제외할 방 코드(쉼표구분) |
| `YOUTUBE_API_KEY` | — | 있으면 추가 시점에 임베드 차단 영상을 미리 거른다 |
| `DATA_GO_KR_SERVICE_KEY` | — | 한국 공휴일 KASI API 키(선택). 없으면 번들 정적 목록만으로 동작 |
| `EXTRA_HOLIDAYS` / `HOLIDAY_OVERRIDES_OFF` | — | 공휴일 강제 추가/제외(`YYYY-MM-DD`, 쉼표구분, 서버 전역) |

> 상세 실행(컴퓨터 / Android Termux / 공개 터널)·포크 체크리스트는 [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) 참고.

## 📖 Usage

프로토콜과 클라이언트 액션은 모두 코드에 공개돼 있다.

**공유 프로토콜 (`@remote-dj/shared`)** — 이벤트 상수와 유틸이 서버·웹의 단일 진실 소스다.

```ts
import { C2S, S2C, parseYouTubeId } from '@remote-dj/shared';

C2S.ChangeTrack; // 'changeTrack'  (클라이언트 → 서버)
S2C.State;       // 'state'        (서버 → 클라이언트, RoomState 전체)

parseYouTubeId('https://youtu.be/dQw4w9WgXcQ'); // → 'dQw4w9WgXcQ'
parseYouTubeId('https://example.com/x');         // → null
```

**클라이언트 액션 (`apps/web/lib/roomStore.ts`)** — 모든 조작은 ack를 돌려주는 안전한 emit이다.

```ts
import { actions } from '@/lib/roomStore';

// 곡 변경은 사유가 필수 (빈 사유는 서버가 거부)
const ack = await actions.changeTrack('https://youtu.be/dQw4w9WgXcQ', '분위기 띄우려고');
if (!ack.ok) console.warn(ack.error); // 예: 'reason required', 'embed disabled'

// 음량 조절 — 사유는 선택 (남기면 다른 사람이 이유를 확인)
await actions.setVolume(60, '통화 중이라 잠깐 줄임');

// 큐에 추가 / 반복 모드
await actions.enqueueTrack('https://www.youtube.com/watch?v=abc12345678');
await actions.setRepeat('all');
```

Player·Controller 화면은 `useRoomState()` 등 세분화된 selector 훅으로 서버가 푸시하는 상태를 구독한다. 곡 변경(사유 필수) → 서버 검증 → `RoomState` 갱신 → 전원에게 `state` + `activity` 브로드캐스트가 한 흐름이다.

## 🧩 폴더 구조

```
remote-dj/
├── package.json          # workspaces 루트 (packages/*, apps/*)
├── tsconfig.base.json    # 공통 컴파일러 옵션
├── biome.json            # lint + format
├── vitest.config.ts      # projects (shared/server=node, web=jsdom)
├── docs/                 # SPEC / ARCHITECTURE / DEPLOYMENT / LOGGING / qa
├── qa/server/            # Python 블랙박스 프로토콜 하네스 (contract.json 소비)
├── scripts/              # export-contract.mjs
├── packages/
│   └── shared/           # 프로토콜 상수 + 타입 + 유틸 (단일 파일)
└── apps/
    ├── server/           # Socket.IO 권위 서버 (tsx)
    └── web/              # Next.js 15 App Router (landing / player / controller)
```

**문서**

| 문서 | 내용 |
| --- | --- |
| [docs/SPEC.md](./docs/SPEC.md) | 기능·WebSocket 프로토콜·검증 규칙·Activity Log 계약 |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 모노레포 구조·동기화 모델·RoomStore·타입 공유 |
| [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) | 컴퓨터 / Termux / 터널 실행 + 포크 체크리스트 |
| [docs/LOGGING.md](./docs/LOGGING.md) | 진단 로그(JSONL) 계약 |
| [docs/qa/](./docs/qa/) | 수용 기준(Given/When/Then) — 블랙박스 테스트의 기준 |

## 🧪 개발 / 품질 게이트

```bash
npm run typecheck          # 워크스페이스별 tsc --noEmit
npm run lint               # Biome(포맷+린트) + ESLint(web, next/core-web-vitals)
npm test                   # Vitest 유닛 + Socket.IO 통합
npm run e2e -w apps/web     # Playwright 멀티컨텍스트 E2E (웹 블랙박스)
npm run contract:export    # 프로토콜 계약 스냅샷(qa/contract.json) 갱신
# 서버 블랙박스(별도 런타임): qa/server (python-socketio + pytest)
```

CI(GitHub Actions)는 계약 드리프트 검사 → typecheck → Biome → ESLint → Vitest,
그리고 Playwright 웹 E2E와 Python 서버 블랙박스를 각각 별도 job으로 돌린다.

## 🗺 Roadmap (비범위 / 예정)

- QR 페어링
- 본격 인증
- (일부 완료) 영속 저장소 — 현재 JSON 파일 영속이 기본이며 SQLite/Postgres 백엔드는 동일 `RoomStore` 인터페이스로 교체 가능하도록 설계됨

## 📄 License

[MIT](./LICENSE) © 2026 monocsp
