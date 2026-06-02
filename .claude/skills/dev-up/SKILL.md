---
name: dev-up
description: Use when the user wants to run/start/launch the remote-dj app locally (server + web together).
---

# dev-up — 로컬 실행

## 실행
저장소 루트에서:

```bash
npm run dev
```

`concurrently` 로 두 워크스페이스를 함께 띄운다:
- **server** → `http://localhost:3001` (Socket.IO, `apps/server`)
- **web** → `http://localhost:3000` (Next.js, `apps/web`)

설치가 안 됐다면 먼저 루트에서 `npm install`.

## 다른 기기(폰)에서 참가
같은 Wi-Fi에 있는 다른 기기에서 브라우저로 접속:

```
http://<이-컴퓨터의-LAN-IP>:3000
```

- LAN IP 확인(mac): `ipconfig getifaddr en0`
- 클라이언트는 **페이지 host에서 서버 URL을 자동 도출**한다(`apps/web/lib/serverUrl.ts`). 즉 폰이 `http://192.168.x.y:3000` 으로 열면 서버는 같은 호스트의 `:3001` 로 자동 연결된다. 별도 설정 불필요.
- Landing(`/`)에서 역할(Player/Controller) 선택 → 방 코드 입력/생성 → 닉네임(선택).

## 역할 메모
- **Player** 페이지는 YouTube IFrame Player로 실제 재생하므로, **그 폰의 브라우저에서 YouTube 로그인이 선행**되어야 한다.
- Controller는 곡/음량/재생/설정만 원격 제어하며 재생은 하지 않는다.

## 배포/터널
LAN 밖에서 접속하거나 Termux(안드로이드)/별도 컴퓨터/터널(예: cloudflared) 구성은 `docs/DEPLOYMENT.md` 참고.
