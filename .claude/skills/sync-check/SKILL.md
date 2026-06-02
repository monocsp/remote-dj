---
name: sync-check
description: Use to verify the remote-dj realtime protocol is consistent across packages/shared, apps/server, apps/web and matches docs/SPEC.md.
---

# sync-check — 프로토콜 일관성 검증

shared가 단일 진실 공급원이다. 아래 항목을 grep으로 교차 확인한 뒤 빌드/테스트를 돌린다.

## 1) C2S 이벤트 — server 핸들러 + web 사용
`packages/shared/src/index.ts` 의 `C2S` 각 키마다:
```bash
# 예: ChangeTrack → 'changeTrack'
grep -rn "C2S.ChangeTrack" apps/server/src   # socket.on(C2S.X 가 있어야 함
grep -rn "C2S.ChangeTrack" apps/web/lib      # emitWithAck(C2S.X 사용이 있어야 함
```
모든 `C2S.X` 가 server에 `socket.on(C2S.X` 핸들러 1개 + web useRoom에 `emitWithAck(C2S.X` 사용 1개를 가져야 한다.

## 2) `*Payload` 타입 사용 확인
```bash
grep -rno "[A-Za-z]*Payload" packages/shared/src/index.ts | sort -u
# 각 Payload 가 apps/server/src/index.ts 핸들러에서 import/사용되는지
grep -rn "Payload" apps/server/src/index.ts
```
미사용 Payload는 dead code이거나 핸들러 누락 신호.

## 3) S2C 이벤트 — server emit + web 수신
`S2C` (State/Activity/ActivityLog) 각 키마다:
```bash
grep -rn "S2C.State\|S2C.Activity\|S2C.ActivityLog" apps/server/src   # emit 있어야 함
grep -rn "S2C.State\|S2C.Activity\|S2C.ActivityLog" apps/web/lib       # socket.on 핸들러 있어야 함
```

## 4) ActivityType — ActivityFeed 렌더링
```bash
grep -n "ActivityType =" packages/shared/src/index.ts
grep -n "TYPE_LABEL" apps/web/components/ActivityFeed.tsx
```
`TYPE_LABEL` 은 `Record<ActivityType, string>` 이므로 누락 시 typecheck가 잡지만, recordActivity가 실제 그 type을 쓰는지도 확인.

## 5) 빌드/린트/테스트
```bash
npm run typecheck
npm run lint
npm test
```

## 6) SPEC 대조
`docs/SPEC.md` 이벤트 표(C→S/S→C 행)를 `C2S`/`S2C` 상수와 1:1 비교. 데이터 타입 코드블록(RoomState/ActivityEntry/ActivityType)도 shared와 일치하는지 확인. 검증 규칙 표가 server 핸들러의 실제 ack error 문자열과 맞는지 본다.

## 깊은 감사
구조적/의미적 누락(예: emit 되지만 처리 안 되는 이벤트, SPEC drift)은 (예정된) **protocol-auditor 서브에이전트**에 위임해 전수 검사하는 것을 권장.
