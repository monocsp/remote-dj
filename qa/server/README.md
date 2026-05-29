# qa/server — 서버 블랙박스 프로토콜 하네스 (Python)

remote-dj 서버를 **외부에서(over the wire)** 검증하는 `python-socketio` 하네스다.
서버/`@remote-dj/shared` TS를 **import하지 않는다** — 이벤트명/한계값은
`qa/contract.json`(루트에서 `npm run contract:export` 로 생성)만 읽는다.
이 격리가 테스터의 구현 동조(drift/bias)를 막는다.

각 테스트는 `docs/qa/*.md` 의 시나리오 ID(`TRK-01`, `PAIR-06`, `RT-02` 등)에 매핑된다.

## 사전 준비

루트에서 계약 스냅샷이 최신인지 확인:

```bash
npm run contract:export   # @remote-dj/shared → qa/contract.json
```

Python 환경:

```bash
cd qa/server
python -m venv .venv
. .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## 실행

```bash
pytest            # qa/server 안에서
pytest -v         # 시나리오 ID별 상세 출력
```

### 서버 기동 방식

- 기본: `conftest.py` 가 루트에서 `npm run dev:server` 를 테스트 PORT(기본 3099)로
  띄우고 `GET /health` 가 `ok` 가 될 때까지 기다린 뒤, 세션 종료 시 프로세스 그룹을
  정리한다. PORT는 `REMOTE_DJ_TEST_PORT` 로 변경 가능.
- 이미 떠 있는 서버를 쓰려면:

  ```bash
  REMOTE_DJ_SERVER_URL=http://localhost:3001 pytest
  ```

  이 경우 하네스는 아무것도 spawn하지 않고 해당 URL을 그대로 사용한다.

## 검증 방식

- Client→Server 이벤트는 `sio.call(event, payload)`(ack 콜백)로 ack를 동기 수신.
- Server→Client(`state`/`activity`/`activityLog`)는 이벤트 핸들러가 버퍼링하고
  타임아웃 기반 대기(`wait_event`)로 단언한다.
- 어떤 테스트도 TS를 import하지 않으며 HTTP `/health` + Socket.IO만 사용한다.
