# 인수: 페어링 (입장 / 방 코드 / 비밀번호 / 닉네임)

`PAIR-` 시나리오. SPEC §페어링(룸 코드) 규칙, §보안 — 선택적 방 비밀번호,
§WebSocket 프로토콜 `join`, §개요(기본 익명).

> 비고: web Landing UI는 현재 비밀번호 입력란을 노출하지 않을 수 있다(미구현). 비밀번호
> 시나리오는 **server 하네스(블랙박스 socket)** 에서 1차로 검증한다. web은 `join` 페이로드에
> password를 실어 보낼 수 있는 경로(roomStore)가 있으므로 happy-path/wrong을 보조 검증한다.

---

## PAIR-01 — 신규 방에 입장하면 state + activityLog를 받는다
SPEC: §프로토콜 `join` — 성공 시 해당 소켓에 `state` + `activityLog` 전송.

- **Given** 아직 존재하지 않는 방 코드 `R`
- **When** `controller` 가 `join { roomCode: R, role: 'controller' }` 를 보낸다
- **Then** ack `{ ok: true }` 이고, 같은 소켓이 `state`(roomCode=R) 와 `activityLog`(배열) 를 1회 수신한다

## PAIR-02 — 방 코드는 6자 대문자 혼동제거 charset
SPEC: §페어링 — 6자 대문자, charset `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`(I/O/0/1 제외).

- **Given** Landing에서 "코드 생성"을 누른다
- **When** 생성된 코드를 읽는다
- **Then** 정확히 6자이며 모든 문자가 charset에 속한다(`I O 0 1` 미포함)

## PAIR-03 — 닉네임은 선택, 미입력 시 익명(actor=null)
SPEC: §개요 — 기본 익명, 닉네임 선택. §Activity actor null = 익명.

- **Given** 닉네임 없이 입장한 controller
- **When** 임의의 조작(예: togglePlay)을 한다
- **Then** 그 activity의 `actor` 가 `null` 이다

## PAIR-04 — 닉네임 입력 시 actor에 반영
SPEC: §개요 — 닉네임 선택 입력. §Activity actor.

- **Given** `nickname: '철수'` 로 입장한 controller
- **When** 조작을 한다
- **Then** activity의 `actor` 가 `'철수'` 다

## PAIR-05 — 최초 생성자가 비밀번호를 설정하면 비공개 방
SPEC: §보안 — 최초 join의 password(trim)가 방 비밀번호가 된다.

- **Given** 새 방 `R`
- **When** 첫 join이 `password: 'secret'` 로 들어온다
- **Then** ack `{ ok: true }` (방 비밀번호 = `secret` 로 설정됨)

## PAIR-06 — 기존 비공개 방에 잘못된 비밀번호로 입장하면 거부
SPEC: §보안 — 불일치/누락 시 ack `{ ok:false, error:'wrong password' }`.

- **Given** PAIR-05로 비밀번호 `secret` 가 설정된 방 `R`
- **When** 다른 소켓이 `password: 'nope'` (또는 누락)으로 join
- **Then** ack `{ ok: false, error: 'wrong password' }`

## PAIR-07 — 기존 비공개 방에 올바른 비밀번호면 입장
SPEC: §보안 — 일치 시 입장.

- **Given** 비밀번호 `secret` 방 `R`
- **When** 다른 소켓이 `password: 'secret'` 로 join
- **Then** ack `{ ok: true }` 이고 `state`/`activityLog` 수신

## PAIR-08 — 공개 방(비밀번호 없음)은 password를 무시
SPEC: §보안 — 비밀번호 없는 방은 join.password 무시, 자유 입장.

- **Given** 비밀번호 없이 생성된 공개 방 `R`
- **When** 누군가 `password: '아무거나'` 를 실어 join
- **Then** ack `{ ok: true }` (무시되고 입장)

## PAIR-09 — 비밀번호는 절대 브로드캐스트되지 않는다
SPEC: §보안 — 비밀번호는 서버에만 보관, RoomState로 노출 금지.

- **Given** 비밀번호 방에 입장한 소켓
- **When** 수신한 모든 `state` 페이로드를 검사
- **Then** 어떤 필드에도 비밀번호 값이 포함되지 않는다

## PAIR-10 — 비밀번호 길이 초과는 거부
SPEC: §검증 — `withinLimit(password, 64)`.

- **Given** 새 방
- **When** join.password 가 65자
- **Then** ack `{ ok: false }` (`error` 에 too long 류)

## PAIR-11 — 닉네임 길이 초과는 거부
SPEC: §검증 — `withinLimit(nickname, 40)`.

- **Given** 새 방
- **When** join.nickname 이 41자
- **Then** ack `{ ok: false, error: 'nickname too long' }`

## PAIR-12 — roomCode/role 누락 시 거부
SPEC: §프로토콜 `join` 페이로드 필수 필드.

- **Given** 연결된 소켓
- **When** roomCode 또는 role 없이 join
- **Then** ack `{ ok: false }`
