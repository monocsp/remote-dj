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
// multiple Korean calendar references. (제헌절 7/17 was re-instated as a public
// holiday from 2026 — law passed 2026-01-29 — and gains a 대체공휴일 from 2027.)
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
  '2026-07-17', // 제헌절 (금) — 2026 재지정 공휴일 (2026-01-29 법 통과, 시행 2026)
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
  '2027-07-17', // 제헌절 (토)
  '2027-07-19', // 제헌절 대체공휴일 (제헌절 대체는 2027부터 적용)
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

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Build an `isHoliday(now)` predicate from the bundled set plus operator
 * overrides and an optional live "dynamic" set (e.g. the KASI API result, read
 * through a getter so it can be hot-swapped after a refresh). Effective
 * membership is set algebra on the KST date:
 *   (KR_HOLIDAYS ∪ dynamic ∪ extra) \ off
 * `extra` force-adds dates (e.g. a freshly-gazetted 임시공휴일); `off`
 * force-cancels them (play through a date anyway). A miss in `dynamic`/`extra`
 * can never delete a baseline holiday except via `off`, so a failed/empty KASI
 * fetch only ever falls back to the bundled set — never corrupts it.
 */
export function makeIsHoliday(
  extra: ReadonlySet<string> = EMPTY_SET,
  off: ReadonlySet<string> = EMPTY_SET,
  dynamic: () => ReadonlySet<string> = () => EMPTY_SET,
): (now: Date) => boolean {
  return (now: Date) => {
    const key = kstParts(now).date;
    return (KR_HOLIDAYS.has(key) || dynamic().has(key) || extra.has(key)) && !off.has(key);
  };
}

/**
 * True iff `s` is a real "YYYY-MM-DD" date that round-trips (rejects
 * "2026-7-17" without zero-pad and impossible dates like "2026-13-40"). Used to
 * validate the EXTRA_HOLIDAYS / HOLIDAY_OVERRIDES_OFF env levers so a typo is
 * surfaced rather than silently ignored (a non-padded date never matches the
 * always-padded kstParts().date key).
 */
export function isYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
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
