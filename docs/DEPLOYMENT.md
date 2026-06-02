# DEPLOYMENT — remote-dj 실행/배포

remote-dj는 web(3000)과 server(3001) 두 프로세스로 구성된다. 둘 다 `0.0.0.0` 에 바인딩되어 같은 네트워크의 다른 기기가 접속할 수 있다. 클라이언트는 빌드 시점에 `NEXT_PUBLIC_SERVER_URL` 을 베이크하므로, 서버 주소가 바뀌면 **web을 다시 빌드** 해야 한다. (env를 안 줄 때 web은 런타임에 **같은 호스트의 `웹포트+1`** 을 서버로 잡으므로 — 3000→3001, 3100→3101 — LAN 환경에선 재빌드가 필요 없다.)

## 운영 모델 — prd(상시) + dev(개발) 동시 실행

main = **운영(prd)**, 브랜치 = **개발(dev)**. 한 맥에서 둘을 동시에 띄우려고 **포트·데이터·작업 디렉터리**를 분리한다. PR 머지는 prd에 자동 반영되지 않는다(CD 없음) — 릴리즈는 prd 디렉터리에서 `git pull` 후 재시작할 때만 일어난다. 데이터(`apps/server/.data*/rooms.json`)는 `.gitignore` 대상이라 pull/재빌드로 덮어쓰이지 않는다.

| | prd (운영) | dev (개발) |
| --- | --- | --- |
| 브랜치 | `main` | feature 브랜치 |
| 디렉터리 | `../remote-dj-prd` (git worktree) | 이 저장소 |
| web 포트 | **3000** | **3100** |
| server 포트 | **3001** | **3101** |
| 데이터 파일 | `.data/rooms.json` | `.data-dev/rooms.json` |
| 접속 주소 | `http://<맥-LAN-IP>:3000` | `http://<맥-LAN-IP>:3100` |
| 실행 | `npm run prd:build && npm run prd` | `npm run dev:alt` |

```bash
# prd worktree 최초 1회 생성 (main 체크아웃 + 서버 .env 복사)
git worktree add ../remote-dj-prd main
cp apps/server/.env ../remote-dj-prd/apps/server/.env   # YOUTUBE_API_KEY 등
cd ../remote-dj-prd && npm install && npm run prd:build && npm run prd

# 이후 prd 릴리즈 (데이터 유지: .data/ 는 그대로 둠)
cd ../remote-dj-prd && git pull && npm install && npm run prd:build
# 그리고 prd 프로세스 재시작

# dev (이 저장소에서 브랜치 작업 중)
npm run dev:alt   # web 3100 / server 3101 / .data-dev/
```

## 타깃 A — 컴퓨터에서 실행 (가장 쉬움)

같은 Wi-Fi의 사람들이 접속하는 가장 단순한 방법.

```bash
git clone <repo-url> remote-dj
cd remote-dj
npm install
npm run dev          # web(3000) + server(3001) 동시 실행
```

- 실행한 컴퓨터에서 Player/Controller 모두 `http://localhost:3000` 으로 접근 가능.
- 다른 사람은 같은 Wi-Fi에서 `http://<LAN-IP>:3000` 으로 접속.
- `NEXT_PUBLIC_SERVER_URL` 기본값(`http://localhost:3001`)은 같은 기기 접속에는 동작하지만, **다른 기기에서 접속하려면** 이 값을 `http://<LAN-IP>:3001` 로 바꿔 web을 재빌드해야 한다(아래 포크 체크리스트 참고).

## 타깃 B — Android 폰 + Termux (Player 폰이 서버 겸용)

Player 폰 1대가 서버를 직접 돌리고, 그 폰의 Chrome으로 Player 페이지를 연다.

```bash
# 1) F-Droid 에서 Termux 설치 (Play 스토어 버전 아님)
# 2) Termux 에서:
pkg update && pkg install nodejs-lts git tmux
git clone <repo-url> remote-dj
cd remote-dj
npm install
npm run dev
```

- 폰의 Chrome에서 `http://localhost:3000` → Player 페이지 열기(YouTube 로그인 선행).
- 다른 폰들은 같은 Wi-Fi에서 `http://<폰-LAN-IP>:3000` 으로 Controller 접속.
- **계속 켜두기**: `tmux` 세션 안에서 `npm run dev` 를 실행하고 detach(`Ctrl-b d`)해 화면이 꺼져도 살아있게 한다.
- 타깃 A와 동일하게, 다른 기기 접속을 위해 `NEXT_PUBLIC_SERVER_URL` 을 폰 LAN IP로 설정 후 재빌드 필요.

## 타깃 C — 공개 접속 (선택)

Wi-Fi 밖의 사람도 접속해야 할 때. **Cloudflare Tunnel** 또는 **ngrok** 으로 서버(3001)를 외부에 노출.

```bash
# 예: ngrok 으로 server 노출
ngrok http 3001
# → https://xxxx.ngrok-free.app 형태의 공개 URL 획득
```

```bash
# 예: Cloudflare Tunnel
cloudflared tunnel --url http://localhost:3001
```

이후 공개 URL을 web에 베이크해 재빌드/배포한다.

```bash
NEXT_PUBLIC_SERVER_URL="https://xxxx.ngrok-free.app" npm run build --workspace apps/web
```

- web 자체도 공개해야 한다면 별도 터널(또는 호스팅)로 3000 포트를 노출.

## LAN IP 찾기

| OS | 명령 |
| --- | --- |
| macOS | `ipconfig getifaddr en0` (Wi-Fi는 보통 en0/en1) |
| Linux | `hostname -I` 또는 `ip addr` |
| Windows | `ipconfig` → "IPv4 주소" |
| Termux(Android) | `ifconfig` (`pkg install net-tools`) 또는 `ip addr` 의 wlan0 |

`192.168.x.x` 또는 `10.x.x.x` 형태가 LAN IP다.

## 포트 / 방화벽

- web `3000`, server `3001`, 둘 다 `0.0.0.0` 바인딩.
- 같은 Wi-Fi에서 다른 기기가 접속하려면 OS 방화벽에서 3000/3001 인바운드를 허용해야 한다(macOS 첫 실행 시 수신 허용 팝업, Windows 방화벽 규칙).
- 카페/회사 등 **클라이언트 격리(AP isolation)** 가 걸린 Wi-Fi에서는 기기 간 통신이 막힐 수 있다 → 타깃 C(터널) 사용.

## 포크 체크리스트

1. repo fork/clone 후 `npm install`.
2. 다른 기기에서 접속할 거라면 LAN IP를 확인하고 `NEXT_PUBLIC_SERVER_URL=http://<LAN-IP>:3001` 설정.
3. 로컬 개발: `npm run dev`. 배포용: web을 `NEXT_PUBLIC_SERVER_URL` 베이크 후 `npm run build`.
4. 방화벽에서 3000/3001 허용.
5. Player 폰에서 YouTube 로그인 후 `/player?room=CODE` 접속.
6. Controller들은 `/` 에서 같은 룸 코드로 접속.
7. (선택) 공개 필요 시 터널 설정 후 공개 URL로 web 재빌드.
