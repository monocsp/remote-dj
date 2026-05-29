# QA — remote-dj 인수 테스트(acceptance) 레이어

이 디렉터리는 remote-dj의 **격리된 블랙박스 QA 레이어**다. 구현 코드가 아니라
[`docs/SPEC.md`](../SPEC.md)(계약)에서 **인수 기준(acceptance criteria)** 을 먼저 쓰고,
**실행 중인 앱을 외부에서** 검증한다.

## 철학 — doc-first, 격리, 블랙박스

1. **doc-first** — 먼저 SPEC에서 Given/When/Then 시나리오를 도출해 문서로 고정한다.
   각 시나리오는 안정적인 ID(`PAIR-01` 등)를 가진다. 테스트 코드는 이 문서를 구현한다.
2. **블랙박스** — 테스트는 앱을 **외부(over the wire)** 에서만 본다.
   - **web** → Playwright. 실제 브라우저로 UI를 조작/관찰. YouTube IFrame은 모킹.
   - **server** → Python(`python-socketio`) 하네스. Socket.IO 클라이언트로 이벤트/ack만 본다.
3. **격리(anti-bias)** — server 하네스는 **다른 런타임(Python)** 에 둔다. 따라서
   `@remote-dj/shared` 를 **물리적으로 import할 수 없다**. 이벤트명/한계값은
   [`qa/contract.json`](../../qa/contract.json)(아래 anti-drift 참조)에서만 읽는다.
   이렇게 해서 테스터가 구현 타입에 동조(drift)하지 않는다.

> **화이트박스 dev 테스트는 그대로 유지된다.** Vitest 단위/통합 테스트(`npm test`)는
> 개발자용이며, 이 QA 레이어는 그것을 **대체하지 않고 보완**한다.

## 디렉터리

| 경로 | 내용 |
| --- | --- |
| `docs/qa/*.md` | 영역별 인수 문서 (시나리오 ID + Given/When/Then) |
| `apps/web/e2e/` | Playwright 웹 E2E (`PAIR-*`, `RT-*` 등) |
| `qa/server/` | Python 블랙박스 프로토콜 하네스 (`pytest`) |
| `qa/contract.json` | shared에서 export된 프로토콜 스냅샷(이벤트명/limits) |
| `scripts/export-contract.mjs` | `@remote-dj/shared` → `qa/contract.json` 생성기 |

## 인수 문서 (영역별)

| 문서 | 영역 | ID prefix |
| --- | --- | --- |
| [pairing.md](./pairing.md) | 입장 / 방 코드 / 선택적 비밀번호 / 닉네임 | `PAIR-` |
| [track-change.md](./track-change.md) | 곡 변경(사유 필수, URL 검증, 브로드캐스트/로그) | `TRK-` |
| [volume-playback.md](./volume-playback.md) | 음량 클램프 / 재생·일시정지 / 권한 | `VOL-`, `PLY-` |
| [activity-log.md](./activity-log.md) | 모든 조작 로깅 / join 시 전체 로그 / 캡 | `LOG-` |
| [realtime-invariants.md](./realtime-invariants.md) | 멀티 컨트롤러 동기화 / 방 격리 / presence / version / 재연결 / 입력 길이 | `RT-` |

## 추적성 (traceability)

각 시나리오는 **하나 이상의 SPEC 규칙**으로 추적된다. 인수 문서의 모든 시나리오는
`SPEC: §<섹션> — <규칙>` 형태의 추적 줄을 포함한다. 테스트 코드(웹/서버)는
시나리오 ID를 주석/테스트명에 명시해 **시나리오 ID ↔ SPEC 규칙 ↔ 테스트** 의
1:1(또는 1:N) 매핑을 만든다. 리포트는 항상 시나리오 ID 단위로 pass/fail을 낸다.

## 실행 방법

### 웹 (Playwright)

```bash
# 1회: 브라우저 설치 (격리 환경에서 사전 수행 필요)
npm run e2e:install -w apps/web
# 실행 — playwright webServer가 루트 `npm run dev`로 server(:3001)+web(:3000)을 함께 띄운다
npm run e2e -w apps/web
```

### 서버 (Python python-socketio)

```bash
# 계약 스냅샷 갱신 (shared 변경 시)
npm run contract:export
# Python 환경 준비 + 실행 — 자세한 내용은 qa/server/README.md
cd qa/server && python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
pytest
```

`conftest.py` 가 테스트용 PORT로 Node 서버를 띄우고 `/health` 를 기다린 뒤 종료까지 관리한다.
이미 떠 있는 서버를 쓰려면 `REMOTE_DJ_SERVER_URL` 환경변수를 지정한다.

## anti-drift (계약 export)

Python은 TS를 import하지 않는다. 대신 `scripts/export-contract.mjs` 가
`@remote-dj/shared` 의 `{ C2S, S2C, LIMITS }` 를 읽어 `qa/contract.json` 으로 굳힌다.
shared가 바뀌면 `npm run contract:export` 로 스냅샷을 갱신한다. 스냅샷이 오래되어
실제 서버와 어긋나면 테스트가 실패하므로, 그 자체가 drift 감지 신호가 된다.

## 격리 QA 서브에이전트

`.claude/agents/` 에 블랙박스 테스터 에이전트가 있다. 이들은 **`docs/qa/*` 만 읽고
구현 소스는 읽지 않는다**(기대값 편향 방지).

- `qa-web` — Playwright 웹 인수 테스트 실행/리포트.
- `qa-server` — Python 서버 프로토콜 인수 테스트 실행/리포트.
- `protocol-auditor` — read-only. shared/server/web ↔ SPEC 일관성 감사.
