// Korean public-holiday support for the weekly auto-play schedule.
//
// Korea is a FIXED UTC+09:00 offset (no DST since 1988), so "KST civil time" is
// simply the instant shifted by +9h and read through the UTC getters — no ICU /
// Intl dependency, which keeps this correct on small-ICU runtimes (e.g. Termux).
// Deriving the date, weekday AND wall-clock HH:MM from ONE shifted instant means
// the schedule window and the holiday-date check can never disagree about which
// KST calendar day it is.

import type { DayKey } from '@remote-dj/shared';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
// Indexed by the (KST) Date.getUTCDay() value: 0 = Sunday.
const DAY_KEYS: DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface KstParts {
  date: string; // "YYYY-MM-DD" KST calendar date
  weekday: DayKey; // KST day-of-week
  hhmm: string; // "HH:MM" KST wall clock (24h)
}

/** Civil date / weekday / time in Asia/Seoul (KST, fixed +09:00) for `now`. */
export function kstParts(now: Date): KstParts {
  const k = new Date(now.getTime() + KST_OFFSET_MS);
  const y = k.getUTCFullYear();
  const mo = String(k.getUTCMonth() + 1).padStart(2, '0');
  const d = String(k.getUTCDate()).padStart(2, '0');
  const hh = String(k.getUTCHours()).padStart(2, '0');
  const mi = String(k.getUTCMinutes()).padStart(2, '0');
  return { date: `${y}-${mo}-${d}`, weekday: DAY_KEYS[k.getUTCDay()], hhmm: `${hh}:${mi}` };
}

// Statutory KR public holidays (관공서의 공휴일에 관한 규정) as KST "YYYY-MM-DD",
// INCLUDING 대체공휴일. Lunar holidays (설날/추석/부처님오신날) are pre-resolved to
// their solar dates. Web-verified for 2026 & 2027 against the KASI 월력요항 plus
// multiple Korean calendar references.
//
// ⚠️ ANNUAL UPDATE: append the next year's dates before December (a unit test
// fails once the set stops covering the current year). Ad-hoc 임시공휴일 and
// one-off 선거일 that are declared after this list ships are NOT here — add them
// at runtime via the EXTRA_HOLIDAYS env lever (see apps/server/src/index.ts).
export const KR_HOLIDAYS: ReadonlySet<string> = new Set<string>([
  // ── 2026 ──
  '2026-01-01', // 신정
  '2026-02-16', // 설날 연휴 (전날)
  '2026-02-17', // 설날
  '2026-02-18', // 설날 연휴 (다음날)
  '2026-03-01', // 3·1절 (일)
  '2026-03-02', // 3·1절 대체공휴일
  '2026-05-05', // 어린이날
  '2026-05-24', // 부처님오신날 (일)
  '2026-05-25', // 부처님오신날 대체공휴일
  '2026-06-03', // 제9회 전국동시지방선거 (선거일, 1회성)
  '2026-06-06', // 현충일
  '2026-08-15', // 광복절 (토)
  '2026-08-17', // 광복절 대체공휴일
  '2026-09-24', // 추석 연휴 (전날)
  '2026-09-25', // 추석
  '2026-09-26', // 추석 연휴 (다음날, 토 — 일요일 겹침 없음 → 대체 없음)
  '2026-10-03', // 개천절 (토)
  '2026-10-05', // 개천절 대체공휴일
  '2026-10-09', // 한글날
  '2026-12-25', // 성탄절
  // ── 2027 ──
  '2027-01-01', // 신정
  '2027-02-06', // 설날 연휴 (전날)
  '2027-02-07', // 설날 (일)
  '2027-02-08', // 설날 연휴 (다음날)
  '2027-02-09', // 설날 대체공휴일
  '2027-03-01', // 3·1절 (월)
  '2027-05-05', // 어린이날
  '2027-05-13', // 부처님오신날
  '2027-06-06', // 현충일 (일 — 법상 대체 없음)
  '2027-08-15', // 광복절 (일)
  '2027-08-16', // 광복절 대체공휴일
  '2027-09-14', // 추석 연휴 (전날)
  '2027-09-15', // 추석
  '2027-09-16', // 추석 연휴 (다음날)
  '2027-10-03', // 개천절 (일)
  '2027-10-04', // 개천절 대체공휴일
  '2027-10-09', // 한글날 (토)
  '2027-10-11', // 한글날 대체공휴일
  '2027-12-25', // 성탄절 (토)
  '2027-12-27', // 성탄절 대체공휴일
]);

/**
 * Build an `isHoliday(now)` predicate from the bundled set plus operator
 * overrides. Effective membership is set algebra on the KST date:
 *   (KR_HOLIDAYS ∪ extra) \ off
 * `extra` force-adds dates (e.g. a freshly-gazetted 임시공휴일); `off`
 * force-cancels them (play through a date anyway). A miss in either env can
 * never delete a baseline holiday except via `off`.
 */
export function makeIsHoliday(
  extra: ReadonlySet<string> = new Set(),
  off: ReadonlySet<string> = new Set(),
): (now: Date) => boolean {
  return (now: Date) => {
    const key = kstParts(now).date;
    return (KR_HOLIDAYS.has(key) || extra.has(key)) && !off.has(key);
  };
}

/** Latest calendar year covered by the bundled static set (staleness guard). */
export function maxHolidayYear(): number {
  let max = 0;
  for (const d of KR_HOLIDAYS) {
    const y = Number(d.slice(0, 4));
    if (y > max) max = y;
  }
  return max;
}
