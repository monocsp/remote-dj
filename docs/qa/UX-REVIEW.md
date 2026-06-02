# UX 리뷰 (모바일 우선, 블랙박스)

`.claude/agents/ux-reviewer.md` (격리 블랙박스 에이전트, OneRedOak design-review 패턴 + WCAG)로
실행 중인 웹을 Pixel 7(412×915) + 360×800에서 측정·채점한 결과. 구현 소스를 보지 않고 렌더된
DOM·스크린샷·`getBoundingClientRect` 실측만 근거.

## 요약
핵심 실시간 루프(곡 변경 → now-playing/재생버튼/Activity Log 즉시 갱신, "연결됨" 상시 표시)와
360/412px 반응형(가로 오버플로우 없음)은 **양호**. 주요 약점은 **터치 타깃 다수가 44px 미만**과
**한국어 UI에 영어 에러 노출**.

## 발견사항 (우선순위)

| # | 심각도 | 화면 | 증상(실측) | 수정 |
| --- | --- | --- | --- | --- |
| 1 | **High** | Controller | 음량 슬라이더 340×**16**px (<44, WCAG 2.5.5) | 트랙/thumb hit-area ≥44px (패딩/`touch-action`/큰 thumb) |
| 2 | **High** | Controller | "익명 허용" 체크박스 16×16, 라벨행 20px | 라벨행 ≥44px, 체크박스 24px+ |
| 3 | **High** | Controller | 에러 "invalid youtube url" **영어 노출** | 서버 에러 → 한국어 매핑 |
| 4 | Medium | Controller | "다음 곡" 58×**28**px (<44) | 높이 44px + 인접 간격 24px |
| 5 | Medium | Controller | 제출 비활성 이유 안내 없음 + disabled 대비 ~3.1:1 | inline 힌트 + 회색 disabled |
| 6 | Medium | Controller | 슬라이더↔재생버튼 간격 22px (<24, WCAG 2.5.8) | ≥24px |
| 7 | Nitpick | Controller | now-playing 위계 약함 | 타이포/배경 강조 격상 |
| 8 | Nitpick | 전역 | 보조텍스트 `neutral-500` 4.18:1 (<4.5, WCAG 1.4.3) | `neutral-400`(7.85:1)로 통일 |

## 강점
- 실시간 피드백 명확(곡 변경 후 즉시 반영), "연결됨" 대비 10.3:1.
- 빈 폼 제출 버튼 disabled로 잘못된 제출 사전 차단.

## 환경 이슈(제품 결함 아님)
- Next dev "N" 배지가 일부 버튼과 겹침 → 프로덕션 빌드엔 없음.
- Player 재생오류 배너는 실제 YouTube onError 필요 → 블랙박스 브라우저에서 미검증(ERR은 vitest/Python이 커버).
- Player 콘솔 `web-share`/WebGL 경고는 YouTube iframe 유래(앱 오류 아님).

## 적용 상태
1·2·3·4·6·8은 본 커밋에서 적용. 5·7은 후속(디자인 판단 필요)으로 둠.
근거 스크린샷: ux-reviewer 실행 시 `/tmp/ux/*.png` 생성.
