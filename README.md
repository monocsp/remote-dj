# remote-dj

여러 사람이 **한 대의 "재생용 폰"에서 흐르는 음악을 원격으로 함께 조작**하는 협업형 음악 컨트롤러입니다.
음악은 YouTube 링크 기반으로 추가되며, 곡을 바꾸거나 음량을 조절할 때 **사유(메모)** 를 남길 수 있어
"왜 이 곡으로 바꿨는지 / 왜 소리를 줄였는지"를 다른 사람이 확인할 수 있습니다.

> 상태: 🚀 동작하는 구현체 (모노레포 + 실시간 동기화 + QA 자동화). 서버는 셀프호스트(컴퓨터/안드로이드 Termux)로 누구나 포크해 실행 가능.

## 빠른 시작 (Quickstart)

```bash
npm install
npm run dev          # 서버(:3001) + 웹(:3000) 동시 기동
```

- 같은 Wi-Fi의 다른 폰에서 `http://<이 컴퓨터 IP>:3000` 으로 접속 (클라이언트가 서버 URL을 런타임에 자동 계산 → 재빌드 불필요)
- Player 폰은 브라우저에서 YouTube 로그인 후 `/player` 진입, Controller는 `/controller`
- 상세 실행(컴퓨터 / 안드로이드 Termux / 공개 터널)·검증: [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)

| 문서 | 내용 |
| --- | --- |
| [docs/SPEC.md](./docs/SPEC.md) | 기능·WebSocket 프로토콜·검증 규칙·Activity Log 계약 |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 모노레포 구조·동기화 모델·RoomStore·타입 공유 |
| [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) | 컴퓨터/Termux/터널 실행 + 포크 체크리스트 |
| [docs/qa/](./docs/qa/) | 수용기준(Given/When/Then) — 격리 블랙박스 테스트의 기준 |

## 개발 / 품질 게이트

```bash
npm run typecheck    # 3개 워크스페이스 tsc
npm run lint         # Biome(포맷+린트) + ESLint(web, next/core-web-vitals)
npm test             # Vitest 유닛 + Socket.IO 통합
npm run e2e -w apps/web   # Playwright 멀티컨텍스트 E2E (웹 블랙박스)
# 서버 블랙박스(별도 런타임): qa/server (python-socketio + pytest)
```

## 핵심 개념

시스템에는 두 종류의 역할이 있습니다.

| 역할 | 설명 |
| --- | --- |
| **Player (재생용 폰)** | 실제로 음악을 재생하는 단말. 재생/조작을 위해 **YouTube 로그인이 필요**. 컨트롤러가 보낸 설정에 따라 곡·음량이 바뀜 |
| **Controller (조작 유저들)** | 여러 명이 동시에 접속해 곡 변경 / 음량 조절 / 설정을 수행. **휴대폰 화면 기준의 반응형 웹** |

## 기능 요구사항

1. **연결** — 하나의 Player 폰에 여러 Controller가 연결되고, Player는 컨트롤러의 설정에 따라 실시간으로 반영된다.
2. **곡 변경 + 사유** — 현재 재생 중인 곡을 바꿀 때는 **사유 입력을 필수**로 한다.
3. **사유는 선택(기본 익명)** — 음량 조절·설정 변경은 기본 익명으로 동작하며, 사유는 *선택적으로* 남길 수 있다.
   남기면 다른 유저가 변경 이유를 확인할 수 있다.
4. **YouTube 기반 재생** — 곡은 보통 YouTube 링크로 추가한다. Player 폰은 재생·조작을 위해 YouTube 로그인을 선행해야 한다.
5. **반응형 (모바일 우선)** — Controller 웹은 휴대폰 화면 크기를 기본으로 제공하는 반응형 UI여야 한다.

## 동작 흐름 (개념)

```
[Controller A]  ┐
[Controller B]  ├──(곡 변경 / 음량 / 설정 + 선택적 사유)──▶  [동기화 계층]  ──▶  [Player 폰 / YouTube 재생]
[Controller C]  ┘                                              │
                                                               └──▶ 변경 이력 + 사유 피드 (모두에게 공유)
```

## 변경 이력 (Activity Log)

모든 조작은 이력으로 남는다. 곡 변경은 사유 필수, 그 외는 사유 선택.

| 필드 | 예시 |
| --- | --- |
| 시각 | 2026-05-29 21:13 |
| 행위자 | 익명 / (닉네임) |
| 종류 | 곡 변경 · 음량 · 설정 |
| 사유 | "분위기 띄우려고", "통화 중이라 줄임" |

## 결정 사항 (resolved)

- [x] 동기화 방식 — **Socket.IO** (서버가 권위 상태 보유, 전체 브로드캐스트)
- [x] Player ↔ Controller 페어링 — **방 코드**(+ 선택적 방 비밀번호). QR은 추후
- [x] YouTube 재생 — **IFrame Player API** (Player 폰 브라우저에서 로그인 선행)
- [x] 프런트엔드 스택 — **Next.js 15 + React 19 + Tailwind** (모바일 우선)
- [x] 인증/세션 — 기본 익명 + 선택 닉네임 + 선택적 방 비밀번호 (`allowAnonymous` 설정으로 곡 변경 시 닉네임 강제 가능)

### 구현된 기능

곡 변경(사유 필수) · 음량 · 재생/일시정지 · **재생 큐**(자동/수동 다음 곡) · **Seek**(진행바) · **설정**(allowAnonymous) · **YouTube 재생 오류/복원 UX** · 전체 Activity Log

### 추후 (비범위)

QR 페어링 · 영속 저장소(SQLite/Postgres) · 본격 인증

## 라이선스

[MIT](./LICENSE)
