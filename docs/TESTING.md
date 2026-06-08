# TESTING — 테스트 전략 (회귀 · 기능 · 통합)

remote-dj의 계층형 테스트 전략. Codex 객관 분석 + 프로젝트 현황을 바탕으로 정리했고,
원칙은 **문서 우선 → 블랙박스(수용) → 화이트박스 → 구현**, 그리고 **플레이크 0(고정 sleep·"아무 이벤트나 대기" 금지, 항상 술어 대기)**.

## 1. 테스트 피라미드 (이 레포 기준)

| 계층 | 위치 | 책임 | 도구 |
| --- | --- | --- | --- |
| **Unit** | `packages/shared/src/*.test.ts`, (신규) `apps/web/**/*.test.tsx` | 순수 로직: `parseYouTubeId`/`validateReason`/`clampVolume`, roomStore 셀렉터, 컴포넌트 단위 | Vitest (node / jsdom) |
| **Integration** | `apps/server/src/*.test.ts` | `createServer()` + 실제 `socket.io-client` — 권한·검증·patchState·브로드캐스트·큐·seek·설정·에러 | Vitest (node) |
| **Contract (black-box)** | `qa/server/test_*.py` ↔ `qa/contract.json` | 와이어 너머 프로토콜(다른 런타임, 앱 내부 import 불가) | python-socketio + pytest |
| **E2E (browser)** | `apps/web/e2e/*.spec.ts` | 브라우저 UX + Player/Controller 배선 (YouTube 모킹, Pixel 7) | Playwright |

**현재 갭(추가 권장):** 재연결/resync, disconnect 시 presence 감소, `removeQueued` 해피패스,
잘못된 `progress`/`playbackError` 페이로드, 비밀번호 비노출(state에 password 없음), 룸 TTL,
그리고 web Vitest가 사실상 와이어링 스모크뿐이라 **roomStore/컨트롤러/플레이어 단위 테스트**가 가장 큰 갭.

## 2. 회귀 방지 (실행 분할)

| 시점 | 실행 | 목적 |
| --- | --- | --- |
| **매 커밋** (CI `check`) | `typecheck` + `lint`(Biome+ESLint) + `vitest`(unit+integration) | 빠른 화이트박스 게이트 |
| **매 PR** | `e2e-web`(Playwright) + `qa-server`(Python) | 블랙박스 수용 |
| **야간(nightly)** | 재연결/chaos · soak/memory | 장시간·드문 회귀 (룸 TTL은 시간 주입 단위테스트로 커버) |

- **계약 드리프트 차단:** CI에서 `npm run contract:export` 실행 후 `qa/contract.json` 변경 시 **실패**시킨다(커밋 누락 감지). 로컬 훅으로도 가능.
- **플레이크 정책:** 고정 `sleep` 금지, "아무 이벤트나 대기" 금지. **항상 술어 대기** — 서버 테스트는 `waitFor(socket, event, predicate)`, Python은 `Client.wait_for_state(predicate)`. 낙관적 UI는 **서버 권위 상태가 반영된 최종 UI**를 단언하지(즉시 로컬 토글 상태가 아니라). 
  - 실제 사례: ① `settings` activity가 state보다 먼저 emit되어 "아무 이벤트나 대기"가 stale state를 읽던 레이스 → `wait_for_state`로 해결. ② 서버-제어 체크박스에 `uncheck()`가 즉시 상태변화를 단언하다 실패 → 낙관적 미러 도입 + 교차클라이언트 반영을 단언.

## 3. 기능 개발 레시피 (+ 실제 TDD 도입)

각 기능은 이 순서로:
1. **수용기준 문서** `docs/qa/<feature>.md` (Given/When/Then + 시나리오 ID).
2. **실패하는 블랙박스 테스트 먼저** — 프로토콜만이면 Python, 브라우저 가시 동작이면 Playwright.
3. **가장 좁은 화이트박스 테스트** (shared/server/web) 추가.
4. **구현** (`shared → server → web` 순서; `/new-event` 스킬 참고).
5. 전 계층 그린 + `docs/SPEC.md` 갱신.

> 진짜 TDD = "문서 → 실패 블랙박스 → 실패 화이트박스 → 코드". `apps/server/src/index.ts`부터 고치지 않는다.

## 4. 통합(실시간) 불변식 — 추가 대상

- **동시 조작**: 여러 컨트롤러 동시 액션 → `stateVersion` 단조 증가.
- **재연결/resync**: 재접속 시 최신 `state` + `activityLog` 수신.
- **룸 격리**: `state`·`activity` 둘 다 다른 룸으로 새지 않음(이미 RT-02 일부 커버).
- **presence**: disconnect 시 컨트롤러/Player 카운트 감소.
- **이벤트 순서**: `activity` vs `state` emit 순서 정책 명문화 + 테스트.
- **soak/memory**: 다수 join·progress 폭주에서 로그 캡(200) 동작, 메모리 무증가.
- **룸 TTL**: 빈 방 7일 후 sweep 삭제(부팅 1회 + 1시간 주기). 영속 `emptySince` 타임스탬프 기반(재시작에도 유지) — `markEmpty`(마지막 퇴장)/`markOccupied`(입장)/self-heal(빈 방인데 stamp 없으면 재스탬프). `PINNED_ROOMS` 방은 면제. 테스트는 `sweepEmptyRooms(now)`에 시간 주입(벽시계 대기 없음).
- **보안**: 어떤 `state`/브로드캐스트에도 방 password가 포함되지 않음.

## 5. 폴더/네이밍 + CI 레이아웃

- 테스트 이름에 **시나리오 ID** 유지(`SET-01`, `QUEUE-07` …).
- 파일이 커지면 `docs/qa` 도메인을 미러링해 분리:
  - `apps/web/e2e/{pairing,queue,seek,settings,playback-error}.spec.ts`
  - `qa/server/test_{pairing,queue,seek,settings}.py`
  - `apps/server/src/*.integration.test.ts`
- CI 잡: `check`(빠름) → `qa-server`(계약) → `e2e-web`(브라우저) → `nightly-realtime`(soak/TTL/chaos).
- 격리 QA 서브에이전트: `.claude/agents/qa-web.md`·`qa-server.md`(블랙박스 러너), `ux-reviewer.md`(UX), `protocol-auditor.md`(드리프트). 이들은 `docs/qa`만 읽고 구현 소스는 보지 않는다.
