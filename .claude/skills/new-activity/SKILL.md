---
name: new-activity
description: Use when adding a new Activity Log entry type to remote-dj (a new ActivityType).
---

# new-activity — 새 Activity Log 유형 추가

각 조작은 `ActivityEntry` 1건으로 기록되어 `S2C.Activity` 로 브로드캐스트된다. 새 유형은 아래 순서로 추가한다.

## 편집 순서

### 1) `packages/shared/src/index.ts` — `ActivityType` 확장
```ts
export type ActivityType =
  'track_change' | 'volume' | 'play' | 'pause' | 'settings' | 'seek';
```

### 2) 사유 필수 여부 결정
- **필수**(track_change 스타일): 발행 핸들러에서 `validateReason(reason ?? '')` 검증, 실패 시 `ack({ok:false, error:'reason required'})` 후 `return`. `recordActivity('seek', reason.trim(), detail)`.
- **선택**(volume/play/pause/settings 스타일): `recordActivity('seek', reason?.trim() || null, detail)`.

### 3) `apps/server/src/index.ts` — 해당 핸들러에서 기록
관련 `socket.on(C2S.*)` 핸들러 안에서 `patchState` 다음에 호출:
```ts
await recordActivity('seek', reason?.trim() || null, { positionSec });
```
`recordActivity(type, reason, detail?)` 가 `actor`(닉네임 또는 null)·`ts`·`id` 를 채우고 `S2C.Activity` 로 emit + 로그에 append 한다.

### 4) `apps/web/components/ActivityFeed.tsx` — 렌더링
`TYPE_LABEL` (Record<ActivityType, string>) 에 한글 라벨 추가. 타입이 누락되면 **typecheck가 실패**하므로 반드시 추가.
```ts
const TYPE_LABEL: Record<ActivityType, string> = {
  /* ...기존... */
  seek: '구간 이동',
};
```
(아이콘을 쓰고 싶으면 같은 Record 패턴으로 추가.)

### 5) `docs/SPEC.md` — Activity Log 섹션
`ActivityType` 유니온 코드블록과 Activity Log 스키마/예시 표를 갱신. 사유 필수면 "항상 `reason` non-null" 메모도 추가.

## 체크리스트
- [ ] shared `ActivityType` 유니온에 값 추가
- [ ] 사유 필수/선택 결정 → 핸들러 검증 반영
- [ ] server 핸들러에서 `recordActivity('<type>', reason, detail)`
- [ ] ActivityFeed `TYPE_LABEL` 에 한글 라벨 추가
- [ ] docs/SPEC.md Activity Log 섹션 동기화
- [ ] `npm run typecheck` 통과 (Record 누락 시 실패)
