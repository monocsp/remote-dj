# 인수: 음량 정규화 (Loudness Normalization)

`GAIN-` 시나리오. SPEC §프로토콜 `setTrackGain`, §음량 정규화(곡별 게인 `trackGain`,
감쇠 전용 `[0.2,1.0]`, 수동 A + loudnessDb 자동 시드 B, 수동 우선, 실패 시 no-op),
§권한 규칙, §데이터 타입(`RoomState.trackGain`), §Activity(`gain`).

---

## GAIN-01 — setTrackGain은 state.trackGain[id]를 갱신하고 gain으로 기록
SPEC: §음량 정규화 — 수동 게인은 `trackGain[videoId]` 설정 + activity `gain`.

- **Given** Player + Controller가 같은 방
- **When** Controller가 `setTrackGain { videoId: 'dQw4w9WgXcQ', gain: 0.5 }`
- **Then** ack `{ ok: true }`; 방의 모든 소켓이 `state` 수신, `trackGain['dQw4w9WgXcQ'] === 0.5`;
  `activity` 1건 `type === 'gain'`, `detail.gain === 0.5`

## GAIN-02 — gain은 [0.2, 1.0]으로 클램프
SPEC: §검증 규칙 — `clampGain(g)` = 소수 2자리 반올림 후 0.2..1.0.

- **Given** 방의 controller
- **When** `setTrackGain { videoId, gain: 5 }` 그리고 `gain: 0`
- **Then** 각각 `trackGain[videoId] === 1.0` (상한), `=== 0.2` (하한)으로 저장

## GAIN-03 — changeTrack은 YouTube loudnessDb에서 게인을 자동 시드
SPEC: §음량 정규화(B) — `changeTrack`/`enqueueTrack` 후 fire-and-forget 자동 시드.

- **Given** loudnessDb가 +6 dB(곡이 기준보다 큼)로 보고되는 방의 controller
  (블랙박스 서버는 `REMOTE_DJ_FAKE_LOUDNESS=6`)
- **When** Controller가 새 url로 `changeTrack`
- **Then** ack `{ ok: true }`; 잠시 후 `state.trackGain[id]` 가 정의되고 `0 < gain < 1`
  (≈ `10^(-6/20)` ≈ 0.5). 자동 시드는 **activity를 남기지 않는다**

## GAIN-04 — 자동 시드는 수동 게인을 덮어쓰지 않음
SPEC: §음량 정규화(B) — 해당 videoId에 이미 게인이 있으면 자동 시드는 건너뛴다(수동 우선).

- **Given** loudnessDb가 +6 dB로 보고되는 방(자동 시드 시 ≈0.5)
- **When** Controller가 먼저 `setTrackGain { videoId: id, gain: 0.8 }`(수동) 후 같은 id로 `changeTrack`
- **Then** `trackGain[id]` 는 **0.8 유지**(자동 시드가 기존 값을 덮어쓰지 않음)
