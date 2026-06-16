---
name: pull-request
description: remote-dj에서 PR(풀 리퀘스트)을 올릴 때. 제목은 Conventional Commits, 본문은 .github/PULL_REQUEST_TEMPLATE.md 형식으로 작성하고 gh로 생성한다. PR 만들기·PR 본문 작성·"PR 올려줘" 요청 시 사용.
---

# pull-request — PR 작성/생성

널리 쓰이는 OSS(react, next.js, electron, home-assistant, prettier 등)의 공통
관례를 따른다. 짧고 사실적으로, 이슈를 모르는 리뷰어도 이해하게 쓴다.

## 제목 — Conventional Commits

```
<type>(<scope>): <명령형 소문자 요약>
```

- type: `feat` `fix` `docs` `refactor` `perf` `test` `chore` `ci` `build` `style` `revert`
- scope(선택): remote-dj 기준 `shared` `server` `web` `protocol` `player` `controller` `docs`
- 명령형·현재형, 끝에 마침표 없음, 한 줄로 짧게. Breaking 이면 `feat(server)!:` 처럼 `!`.
- 예: `feat(web): add volume slider to controller`, `fix(server): validate seek bounds`

## 본문 — 템플릿

`.github/PULL_REQUEST_TEMPLATE.md` 를 채운다. 섹션: Summary(무엇·왜 1~3문장) /
Changes(불릿) / Type of change(하나 선택) / How was this tested?(실행한 명령과
결과) / Screenshots(UI 변경 시) / Breaking changes(있으면) / Related issues
(`Closes #`) / Checklist. 해당 없는 섹션은 지운다. 산문은 한국어로 쓰되 AI 티가
안 나게(humanize-korean 규칙) 쓴다.

체크리스트는 **실제로 확인한 것만** 체크한다(추정 금지):
셀프리뷰 / `npm test` 통과 / `npm run lint`·`npm run typecheck` 통과 / 문서 갱신
/ 디버그 잔여물 없음 / Breaking 문서화 / AI 생성 코드 검토.

## 생성 (gh)

```bash
gh pr create --base main --head <branch> \
  --title "feat(scope): ..." \
  --body-file <작성한_본문.md>   # 또는 --body "..."
```

- 본문이 길면 임시 파일에 쓴 뒤 `--body-file` 로 넘긴다(따옴표 이스케이프 회피).
- 생성 후 `gh pr view --web` 로 확인. 체크리스트는 근거를 검증한 뒤 채운다.
