---
name: new-event
description: Use when adding a new realtime Socket.IO control event to remote-dj (e.g. a new action like changeTrack/setVolume/seek). Scaffolds the event consistently across packages/shared, apps/server, and apps/web.
---

# new-event — 새 실시간 제어 이벤트 추가

새 Client→Server 제어 이벤트(`C2S.X`)는 **반드시 아래 순서**로 추가한다. shared가 모든 패키지의 단일 진실 공급원이므로 항상 먼저 고친다.

## 파일 맵 & 편집 순서 (load-bearing)

### 1) `packages/shared/src/index.ts` — 계약 먼저
- `C2S` 객체에 이벤트 이름 추가: `Seek: 'seek',`
- `<Name>Payload` 인터페이스 추가. 사유 필수 이벤트는 `reason: string`, 선택이면 `reason?: string`.
- 상태가 바뀌면 `RoomState` 필드 추가, 새 로그 유형이면 `ActivityType` 유니온 확장 (new-activity 스킬 참고).

```ts
export interface SeekPayload {
  positionSec: number;
  reason?: string;
}
export const C2S = { /* ...기존... */ Seek: 'seek' } as const;
```

### 2) `apps/server/src/index.ts` — 핸들러 (기존 핸들러 그대로 미러)
`io.on('connection')` 안, 다른 `socket.on(C2S.*)` 옆에 추가. **순서가 load-bearing**: requireController 가드 → 검증 → `patchState` → `recordActivity` → `ack({ok:true})` → `broadcastState`. 타입 import도 추가할 것.

```ts
socket.on(C2S.Seek, async (payload: SeekPayload, ack: AckFn) => {
  const room = requireController(ack);
  if (!room) return;
  const { positionSec, reason } = payload ?? ({} as SeekPayload);

  // 사유 필수 이벤트라면 (track_change 스타일):
  // if (!validateReason(reason ?? '')) {
  //   ack({ ok: false, error: 'reason required' });
  //   return;
  // }
  // 그 외 검증 실패 시: ack({ ok: false, error: '...' }); return;

  await store.patchState(room, { /* 바뀐 RoomState 필드 */ });
  await recordActivity('seek', reason?.trim() || null, { positionSec });
  ack({ ok: true });
  await broadcastState(room);
});
```
- **사유 필수** 이벤트는 `validateReason(reason ?? '')` 로 검증하고 실패 시 `ack({ok:false, error:'reason required'})` 후 `return`.
- 사유 선택 이벤트는 `recordActivity(type, reason?.trim() || null, detail)`.

### 3) `apps/web/lib/useRoom.ts` — 액션
`UseRoom` 인터페이스에 시그니처 추가 + `useCallback` 액션 추가 + 반환 객체에 노출. `socketRef` null 가드는 `DISCONNECTED_ACK`.

```ts
// UseRoom 인터페이스
seek: (positionSec: number, reason?: string) => Promise<Ack>;

const seek = useCallback((positionSec: number, reason?: string): Promise<Ack> => {
  const socket = socketRef.current;
  if (!socket) return Promise.resolve(DISCONNECTED_ACK);
  return socket.emitWithAck(C2S.Seek, { positionSec, reason });
}, []);
// return { ...기존, seek };
```

### 4) `apps/web/app/controller/page.tsx` (또는 `components/`) — UI 배선
`const { ..., seek } = useRoom(room, 'controller', nick);` 로 꺼내고 UI에서 호출. ack를 검사해 `ack.error` 를 노출한다(현재 폼은 ChangeTrackForm 참고).

```tsx
const ack = await seek(value, reason);
if (!ack.ok) setError(ack.error ?? '실패');
```

## 그 다음
- **테스트**: `apps/server/src/server.test.ts` 에 케이스 추가. `emitWithAck` 로 join 후 이벤트 발행, `waitFor<RoomState>(sock, S2C.State, predicate)` 로 브로드캐스트 확인. 사유 필수면 빈 사유 거부 케이스 + player 거부 케이스도 추가.
- **SPEC**: `docs/SPEC.md` 이벤트 표에 행 추가(이름/방향 C→S/페이로드/ack 결과). 사유 필수면 검증 규칙 표도 갱신.
- **검증**: `npm run typecheck && npm test` (필요시 `npm run lint`).

## 체크리스트
- [ ] `C2S` 에 이름 추가 + `<Name>Payload` 정의 (shared)
- [ ] 필요 시 `RoomState` / `ActivityType` 확장
- [ ] server: requireController → validate → patchState → recordActivity → ack → broadcastState 순서
- [ ] 사유 필수 이벤트는 `validateReason` + `ack({ok:false,error})`
- [ ] useRoom: 인터페이스 + 액션 + 반환 노출
- [ ] controller UI 배선 + `ack.error` 처리
- [ ] server.test.ts 통합 테스트 (성공/거부)
- [ ] docs/SPEC.md 이벤트 표 동기화
- [ ] `npm run typecheck && npm test` 통과
