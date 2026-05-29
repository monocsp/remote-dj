# 인수: 실시간 불변식 (realtime invariants)

`RT-` 시나리오. SPEC §동기화 모델, §프로토콜(state 브로드캐스트 / presence),
§데이터 타입(stateVersion, presence), §검증(입력 길이).

---

## RT-01 — 멀티 컨트롤러 동기화
SPEC: §동기화 모델 — 서버 권위 상태를 방 전체에 브로드캐스트.

- **Given** 같은 방의 Controller A, B (+ Player)
- **When** A가 곡을 변경
- **Then** B도 같은 `state`(동일 currentTrack)를 수신해 UI가 갱신된다

## RT-02 — 방 격리: 다른 방으로 떠난 소켓은 그 방 브로드캐스트를 더 못 받는다
SPEC: §프로토콜 join — 한 소켓은 정확히 한 방에 속한다(이전 방 leave).

- **Given** 소켓 S가 방 `R1` 에 있다가 `R2` 로 다시 join
- **When** `R1` 에서 다른 컨트롤러가 곡 변경
- **Then** S는 `R1` 의 `state`/`activity` 를 받지 않는다(타임아웃). `R2` 의 브로드캐스트만 받는다

## RT-03 — presence 카운트가 정확
SPEC: §데이터 타입 presence `{ playerConnected, controllers }`.

- **Given** 빈 방
- **When** Player 1 + Controller 2 가 입장
- **Then** 브로드캐스트된 state.presence === `{ playerConnected: true, controllers: 2 }`

## RT-04 — 이탈 시 presence 갱신
SPEC: §동기화 — 변경 시 state 재브로드캐스트(presence 재계산).

- **Given** Player + Controller 2 인 방
- **When** Controller 1이 연결 해제
- **Then** 남은 소켓이 controllers === 1 인 state를 수신

## RT-05 — stateVersion 은 매 패치마다 단조 증가
SPEC: §데이터 타입 `stateVersion` — 모든 patch마다 증가(클라이언트가 누락 감지/리싱크).

- **Given** 방의 controller
- **When** 상태를 바꾸는 조작을 2회
- **Then** 연속 수신한 state의 stateVersion 이 엄격히 증가한다

## RT-06 — 재연결/리싱크: 재입장 시 현재 권위 상태를 받는다
SPEC: §프로토콜 join — join 직후 현재 state 1회 전송.

- **Given** 방 `R` 의 상태가 (곡/음량) 갱신된 상태
- **When** 새 소켓(또는 끊겼다 다시 붙은 소켓)이 `R` 에 join
- **Then** 받은 state가 최신 currentTrack/volume/stateVersion 을 반영

## RT-07 — 입력 길이 캡(공통)
SPEC: §검증 — `withinLimit` reason 500 / url 2048 / title 200 / nickname 40 / password 64.

- **Given** 방의 controller(닉네임/비번은 join 단계)
- **When** 각 한계값을 초과하는 입력
- **Then** ack `{ ok: false }` (too long 류), 상태 불변
- **And** 정확히 한계값 길이는 허용된다(경계값)

## RT-08 — Player는 상태 수신 전용
SPEC: §역할 — Player는 join만, 이후 state/activity 수신만.

- **Given** Player 소켓
- **When** 다른 controller가 조작
- **Then** Player는 state/activity 를 수신하지만 스스로 제어 이벤트는 거부됨(PLY-03 참조)
