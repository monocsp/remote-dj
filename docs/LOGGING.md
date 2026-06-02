# LOGGING — remote-dj 운영/에러 로깅 설계

목적: prd/dev 양쪽에서 **유저 동작·설정 변경을 추적**하고, **에러는 별도로 저장**하며,
**웹(클라)에서 발생한 에러를 서버로 자동 전송**해 한곳에 모아, 나중에 사람이나 AI가
*"prd 에러 로그 파악해줘"* 하면 바로 분석할 수 있게 한다.

> 이 로그는 유저용 **Activity Log**(`RoomState.activityLog`, broadcast, UX용)와 **완전히 별개**다.
> Activity Log는 화면에 보이는 기록이고, 여기 정의하는 건 **파일로 쌓이는 진단 로그**다.

## 1. 큰 그림

```
[web/브라우저]                         [server (Node)]
 window.onerror ─┐                      ┌─ socket mutation 핸들러 ─→ ops 스트림
 unhandledreject ┤  POST /internal/     │  process 이벤트(start/stop/
 error.tsx       ├─ logs/web ──────────→┤  uncaught/unhandledRejection) ─→ error
 global-error.tsx│  (sendBeacon/fetch)  │  persist load/save 실패 ─→ error
 socket connect_error ┘                 └─ /internal/logs/web 수신 ─→ ops|error
                                           │
                                           ▼  (pino, 서버만 파일 기록)
                              dirname(REMOTE_DJ_DATA_FILE)/logs/
                                ├─ ops/  YYYY-MM-DD.jsonl
                                └─ error/ YYYY-MM-DD.jsonl
```

- **서버만 파일을 쓴다.** 웹은 서버로 **전송만** 한다 → prd/dev 로그가 자연히 한 디렉터리에 모인다.
- 스트림은 **딱 2개**:
  - **`ops`** — 유저 동작, 설정 변경, join/거절, 룸 생명주기, 서버 start/stop
  - **`error`** — 예외, unhandledRejection, persist 실패, **웹 런타임 에러**, socket connect_error
- **기대 가능한 거절**(wrong password, invalid code, 임베드 차단 등)은 `error`가 아니라
  `ops`의 `level:"warn"`으로 남긴다 — 진짜 장애가 묻히지 않게.

## 2. 환경/출처 구분 (핵심 요구)

| 필드 | 값 | 어떻게 결정 |
| --- | --- | --- |
| `env` | `prd` \| `dev` | **`REMOTE_DJ_ENV` 환경변수로 명시** (추론 금지). prd/dev 스크립트에 박는다 |
| `source` | `server` \| `web` | 기록 주체 |
| `runtime` | `node` \| `browser` \| `next-server` | 실행 컨텍스트 |
| `category` | `room`·`playback`·`queue`·`settings`·`network`·`runtime`·`storage`·`external`·`process`·`ingest` | 도메인 |
| `stream` | `ops` \| `error` | 파일 분리 기준 |

웹이 보내는 `env`/`source`/`ts`는 **신뢰하지 않고 서버가 덮어쓴다**(위조·시계오차 방지).
대신 웹 발생 시각은 `occurred_at`로 따로 남긴다.

## 3. 로그 스키마 (`remote-dj-log/v1`, JSONL 한 줄=한 이벤트)

**공통 필드**

- `schema` `"remote-dj-log/v1"` · `stream` · `level`(`info|warn|error|fatal`)
- `ts` 서버 기록 ISO8601 · `occurred_at` 실제 발생 ISO8601(웹=클라시각)
- `env` · `source` · `runtime` · `category` · `event`(예 `settings.update`, `room.join`, `runtime.unhandled_rejection`)
- `message` 짧은 사람용 요약 · `request_id` 서버 부여
- `room_code`(없으면 null) · `actor_role`(`player|controller|null`) · `actor_nickname?` · `socket_id?`
- `route` 웹 경로만(쿼리는 allowlist만) · `data` 이벤트별 구조화 payload

**ops 추가**: `outcome`(`ok|reject|fail`) · `state_version` · `reason?` · `changes`(설정 전/후 diff만)

**error 추가**: `error{name,message,code,stack,component_stack,digest}` · `severity`(`recoverable|terminal`) ·
`fingerprint`(에러 묶음 키) · `dedupe_key` · `received_from`(`http:web-log`)

예시(설정 변경 / 웹 에러):

```json
{"schema":"remote-dj-log/v1","stream":"ops","level":"info","ts":"2026-06-02T10:15:00.120Z","occurred_at":"2026-06-02T10:15:00.118Z","env":"prd","source":"server","runtime":"node","category":"settings","event":"settings.update","message":"controller updated room settings","request_id":"s_01J...","room_code":"ABCDEF","actor_role":"controller","actor_nickname":"mellow-cat","outcome":"ok","state_version":42,"changes":{"allowAnonymous":{"from":true,"to":false}}}
{"schema":"remote-dj-log/v1","stream":"error","level":"error","ts":"2026-06-02T10:18:04.901Z","occurred_at":"2026-06-02T10:18:04.210Z","env":"prd","source":"web","runtime":"browser","category":"runtime","event":"runtime.unhandled_rejection","message":"Unhandled rejection on controller","request_id":"w_01J...","room_code":"ABCDEF","actor_role":"controller","route":"/controller","fingerprint":"browser:runtime.unhandled_rejection:TypeError:undefined-read","error":{"name":"TypeError","message":"Cannot read properties of undefined","stack":"...trimmed..."},"data":{"connected":false}}
```

## 4. 파일 레이아웃 / 로테이션

- 루트: **`dirname(REMOTE_DJ_DATA_FILE)/logs`** → prd `.data/logs`, dev `.data-dev/logs`
  (둘 다 이미 gitignore. prd/dev가 **같은 디렉터리를 절대 공유하지 않음** — data 파일 기준 파생이라 안전).
- 파일: `logs/ops/YYYY-MM-DD.jsonl`, `logs/error/YYYY-MM-DD.jsonl`
- 로테이션: 일 단위. 같은 날 20MB 초과 시 `.2.jsonl`, `.3.jsonl`.
- 보관: `ops` 14일 / `error` 60일. **압축 없음**(jq·rg·AI가 바로 읽게 raw 유지).

## 5. 웹 → 서버 전송

- **HTTP `POST /internal/logs/web`** (Socket.IO 이벤트 아님).
  이유: 소켓 연결 전/소켓 장애/룸 미입장 상태의 에러도 보낼 수 있고, batch·`sendBeacon`이 쉽다.
- 규칙: body 최대 64KB · 단건/배치 허용(배치 권장) · `Origin`/`Content-Type` 검사 ·
  서버가 `env/source/ts/request_id` 덮어씀.
- **새니타이즈(화이트리스트)**: `data`는 허용된 키만 통과. `password|cookie|authorization|token|key`,
  full URL/query는 제거. **`YOUTUBE_API_KEY` 등 비밀은 절대 로깅 금지.**

## 6. 웹 캡처 지점

필수: `app/error.tsx` · `app/global-error.tsx` · 루트 client bootstrap의 `window.onerror` +
`window.onunhandledrejection` · Socket.IO `connect_error`/비정상 `disconnect`.
권장: 같은 에러가 여러 핸들러에 중복되니 **2~5초 dedupe**(`dedupe_key`). SSR/서버액션 늘면
`apps/web/instrumentation.ts`로 `runtime:"next-server"` 추가.

## 7. 라이브러리 선택 (구현 결정)

- **서버: 자체 경량 로거** (`apps/server/src/logger.ts`, 의존성 없음). 설계 초안은 `pino`였으나,
  tsx 환경에서 pino transport의 워커스레드 마찰을 피하고 스키마/이중 스트림/로테이션을
  완전히 제어하기 위해 직접 구현했다. 저볼륨 LAN 앱이라 **동기 `appendFileSync`** 로 쓴다
  (크래시에도 버퍼 유실 없음, 테스트가 즉시 읽기 가능).
- **웹: 자체 경량 emitter** (`apps/web/lib/clientLog.ts`) — 큐 + batch + `fetch(...,{keepalive:true})`,
  unload/hidden 시 `navigator.sendBeacon` fallback, 동일 `dedupeKey` 5초 dedupe.

## 8. AI 분석 워크플로 ("prd 에러 로그 파악해줘")

1. env로 경로 선택: prd `.data/logs/error/`, dev `.data-dev/logs/error/`.
2. 최신 날짜 파일부터.
3. 묶는 축: `fingerprint` · `event` · `route` · `room_code` · `first_seen`/`last_seen`/`count`.
4. `ops`↔`error`는 `request_id`/`room_code`/`ts`로 교차 추적해 재현 경로 복원.
5. (선택) `scripts/logs-summary.mjs` 보조 스크립트로 fingerprint별 집계 제공.

## 9. 구현 순서 (LOAD-BEARING: shared → server → web)

1. `REMOTE_DJ_ENV` 도입 + 로그 루트를 `REMOTE_DJ_DATA_FILE` 기준 확정. prd/dev 스크립트에 `REMOTE_DJ_ENV` 주입.
2. 서버 `pino` ops/error writer + child logger(공통 필드).
3. 서버 process 이벤트: start/stop, `uncaughtException`, `unhandledRejection`, persist load/save 실패.
4. socket mutation마다 `ops` 구조화 로그(outcome/changes 포함).
5. `POST /internal/logs/web` 수신·검증·redaction.
6. 웹 emitter(큐/batch/dedupe/sendBeacon).
7. `error.tsx`·`global-error.tsx`·window 리스너·socket `connect_error` 연결.
8. size cap/retention/문서(`jq` 예제).

## 10. 로그 폭증 대책 (구현됨)

상시(always-on) 서버에서 로그가 무한정 쌓이지 않도록 4중 방어 (isolate QA + Codex 합의):

1. **주기적 prune** — 시작 시 1회가 아니라 **30분마다** retention + 크기 상한을 재적용
   (`logger.ts` `SWEEP_INTERVAL_MS`, `setInterval(...).unref()`). 시작시에만 정리하면 상시
   서버에선 무력하다.
2. **서버측 flood 차단** — 같은 `fingerprint`의 웹 에러를 **60초당 5건**까지만 기록하고
   초과분은 드롭, 창이 바뀌면 `ingest.flood_suppressed {suppressed:N}` **요약 1줄**만 남김
   (`index.ts` `floodCheck`). 렌더 루프/여러 탭/varying message 폭주를 막는다 — 단, 장애가
   묻히지 않게 suppressed 카운트를 남긴다.
3. **디스크 총량 상한** — stream별 바이트 ceiling(**ops 200MB / error 500MB**) 초과 시
   오래된 파일부터 삭제(retention 내라도). retention/flood가 새 패턴으로 뚫려도 디스크를
   다 먹지 못하게 하는 backstop.
4. **고빈도 ops 샘플링** — 슬라이더 드래그성 `volume/seek/gain`은 ops 미러를
   **socket+type당 ~1초 1건**으로 throttle(`NOISY_OPS`). 유저용 Activity Log 항목은 절대
   드롭하지 않고, 진단 브레드크럼만 샘플링한다.

기타: `progress`/heartbeat 미로깅(가장 큰 폭증원 차단), 일단위 + 같은 날 20MB 사이즈 롤.

> 미구현(설계 옵션으로 남김): per-event before/after `changes` diff, `state_version`,
> `severity` 필드, ops coalescing(드롭 대신 `count/from/to` 1줄 집계). 필요 시 추가.

## 11. 함정 (반드시 회피)

- `progress`/state broadcast/heartbeat는 **로그 금지** — 금방 폭증(2초마다 옴).
- dev의 React/Next는 중복 호출이 많음 → **dedupe 필수**.
- full URL·password·cookie·auth 헤더 **저장 금지**.
- 웹 시계 오차 → `occurred_at`(클라)와 `ts`(서버) **둘 다** 저장.
- prd/dev 로그 디렉터리 **공유 금지**(data 파일 기준 파생).
- 기대 가능한 ack 거절을 전부 `error`로 보내면 진짜 장애가 묻힘 → `ops`/`warn`로.
