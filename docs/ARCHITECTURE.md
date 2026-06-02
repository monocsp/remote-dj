# ARCHITECTURE — remote-dj 아키텍처

## 모노레포 구조

npm workspaces 기반 모노레포.

```
remote-dj/
├── package.json            # workspaces: packages/*, apps/*
├── tsconfig.base.json      # 공통 컴파일러 옵션
├── biome.json              # lint + format
├── vitest.config.ts        # projects 설정 (shared/server=node, web=jsdom)
├── docs/
│   ├── SPEC.md
│   ├── ARCHITECTURE.md
│   └── DEPLOYMENT.md
├── packages/
│   └── shared/             # 프로토콜 상수 + 타입 + 유틸
│       ├── package.json    # main/types/exports → ./src/index.ts
│       └── src/index.ts    # 단일 파일 (내부 상대 import 없음)
└── apps/
    ├── server/             # Socket.IO 권위 서버
    │   ├── package.json
    │   ├── tsconfig.json   # NodeNext
    │   └── src/...         # tsx watch 로 실행
    └── web/                # Next.js 15 App Router
        ├── package.json
        ├── tsconfig.json   # Bundler
        └── app/(landing/player/controller)
```

## 패키지별 책임

| 패키지 | 책임 |
| --- | --- |
| `packages/shared` | WebSocket 프로토콜 상수, TS 타입(`Role`/`RoomState`/`ActivityEntry` 등), 유틸(`parseYouTubeId`/`validateReason`/`clampVolume`/`generateRoomCode`). **단일 파일** `src/index.ts` 로 시작 — 내부 상대 import을 두지 않아 NodeNext의 `.js` 확장자 이슈를 회피 |
| `apps/server` | **권위 상태 보유자**. 이벤트 검증, 룸 상태 관리, 브로드캐스트, Activity Log 보관. Node 22+ / TypeScript / Socket.IO. dev에서 `tsx watch` |
| `apps/web` | Next.js 15 App Router + React 19 + Tailwind. 모바일 우선 반응형. Landing/Player/Controller 화면. Player는 YouTube IFrame Player API 사용 |

## 동기화 모델

서버가 **권위 상태(authoritative state)** 를 단독 보유한다. 클라이언트는 낙관적 추측 없이 서버가 브로드캐스트하는 `state` 를 진실로 받아들인다.

```
   Controller A ─┐ changeTrack/setVolume/...
   Controller B ─┤  (ack 콜백)
   Controller C ─┘
        │
        ▼
   ┌──────────────────────────────┐
   │        Socket.IO Server       │
   │  1. role/payload 검증         │
   │  2. RoomState 갱신 (권위)     │
   │  3. ActivityEntry 생성        │
   └──────────────────────────────┘
        │  broadcast(room)
        ├──────────────► state  (RoomState)   → 전원
        └──────────────► activity (1건)        → 전원
        │
        ▼
   Player 폰 ── state 적용 ──► YouTube IFrame (재생/음량/곡)
```

- 검증 실패 시 상태/로그를 바꾸지 않고 ack로만 에러 반환.
- join 시 해당 소켓에 현재 `state` + 전체 `activityLog` 를 1회 전송.

## RoomStore 인터페이스

상태/로그는 지금은 인메모리지만, 추후 SQLite/Postgres로 교체 가능하도록 **swappable** 인터페이스 뒤에 둔다.

```ts
interface RoomStore {
  getOrCreate(roomCode: string): Promise<RoomState>;
  get(roomCode: string): Promise<RoomState | null>;
  update(roomCode: string, patch: Partial<RoomState>): Promise<RoomState>;

  appendActivity(roomCode: string, entry: ActivityEntry): Promise<void>;
  getActivityLog(roomCode: string): Promise<ActivityEntry[]>;

  setPresence(
    roomCode: string,
    presence: RoomState['presence'],
  ): Promise<void>;
}
```

### 인메모리 구현 계획
- `Map<roomCode, RoomState>` + `Map<roomCode, ActivityEntry[]>`.
- 프로세스 메모리에만 존재 — 재시작 시 초기화.
- 모든 메서드는 `async` 시그니처를 유지해 영속 백엔드 교체 시 호출부 변경이 없도록 한다.

### 향후 영속화
- SQLite(단일 파일) 또는 Postgres 구현체를 동일 인터페이스로 추가.
- 룸은 `rooms` 테이블, 로그는 `activities` 테이블(append-only) 매핑.
- 교체는 DI(서버 부팅 시 store 인스턴스 선택)로 처리.

## 타입 공유 방식

- **web**: `next.config` 의 `transpilePackages: ['@remote-dj/shared']` 로 shared의 TS 소스를 직접 트랜스파일.
- **server**: `tsx` 가 TS를 직접 실행하므로 shared TS 소스를 그대로 import.
- **shared `package.json`**: `main`/`types`/`exports` 를 모두 `./src/index.ts` 로 지정. 빌드 산출물 없이 소스를 직접 소비.
- 단일 파일이라 내부 상대 import이 없어 NodeNext의 `.js` 확장자 요구를 피한다.

## tsconfig 전략

| 위치 | moduleResolution | 비고 |
| --- | --- | --- |
| `tsconfig.base.json` | — | `strict`, target ES2022, 공통 옵션 |
| `apps/web/tsconfig.json` | **Bundler** | Next.js 번들러 환경 |
| `apps/server/tsconfig.json` | **NodeNext** | Node 런타임 |
| `packages/shared/tsconfig.json` | **NodeNext** | 단일 파일이라 확장자 이슈 없음 |

각 패키지 tsconfig는 base를 `extends` 한다.

## 환경변수 / 포트

| 항목 | 값 | 비고 |
| --- | --- | --- |
| web 포트 | `3000` | bind `0.0.0.0` |
| server 포트 | `3001` | bind `0.0.0.0` |
| `NEXT_PUBLIC_SERVER_URL` | `http://localhost:3001` | **build-time 베이크**. 공개 배포 시 공개 URL로 바꿔 재빌드 |

## 테스트 전략 요약

- **러너**: Vitest 3.2+ 의 `projects` 설정(폐기된 workspace 파일 사용 안 함). shared/server = `node` env, web = `jsdom`.
- **통합 테스트**: 실제 Socket.IO 서버를 ephemeral 포트로 띄우고 `socket.io-client` + `emitWithAck` + `waitFor` Promise 헬퍼로 검증. `afterEach` 에서 정리.
- **E2E**: Playwright 멀티 브라우저 컨텍스트(1 Player + 2 Controller). YouTube IFrame은 `page.route` 로 모킹. 모바일 디바이스 프로젝트 포함.
- **CI**: GitHub Actions — `setup-node`(npm cache) → `npm ci` → typecheck → lint → unit+integration. e2e는 Playwright 브라우저 스토어를 캐시하는 별도 job.
- **lint/format**: Biome 단일 바이너리 `npx @biomejs/biome check --write .`.

## 하네스(Claude Code) 계획 — *예정, 미구현*

아래는 향후 도입 **계획** 이며 현재 구현하지 않는다.

- **Skills**: `/new-event`(3개 패키지에 걸친 이벤트 codegen), `/dev-up`, `/new-activity`, `/sync-check`.
- **Subagents**: `protocol-auditor`(read-only), `realtime-qa`, `spec-scribe`.
- **Hooks**: PostToolUse(Write|Edit) → 해당 파일 `biome check --write`; Stop → typecheck(루프 가드 포함).
