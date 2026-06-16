import { describe, expect, it } from 'vitest';
import { KR_HOLIDAYS, kstParts, makeIsHoliday, maxHolidayYear } from './holidays.js';

describe('kstParts (Asia/Seoul, fixed +09:00)', () => {
  it('resolves the KST calendar date across the midnight boundary', () => {
    // 14:59:59Z is 23:59:59 KST same day; 15:00:00Z is 00:00 KST next day.
    expect(kstParts(new Date('2026-10-04T14:59:59Z')).date).toBe('2026-10-04');
    expect(kstParts(new Date('2026-10-04T15:00:00Z')).date).toBe('2026-10-05');
  });

  it('derives date, weekday and HH:MM from the SAME KST instant', () => {
    // 2026-06-01 01:00Z = 10:00 KST Monday.
    const p = kstParts(new Date('2026-06-01T01:00:00Z'));
    expect(p).toEqual({ date: '2026-06-01', weekday: 'mon', hhmm: '10:00' });
  });

  it('is independent of the host timezone (pure offset math)', () => {
    // Same instant regardless of process.env.TZ — uses getTime()+9h only.
    const p = kstParts(new Date(Date.UTC(2027, 1, 6, 15, 0, 0))); // 2027-02-06 15:00Z
    expect(p.date).toBe('2027-02-07'); // 00:00 KST next day
    expect(p.weekday).toBe('sun');
  });
});

describe('KR_HOLIDAYS static set', () => {
  it('includes the four 2026 대체공휴일', () => {
    for (const d of ['2026-03-02', '2026-05-25', '2026-08-17', '2026-10-05']) {
      expect(KR_HOLIDAYS.has(d)).toBe(true);
    }
  });

  it('includes the 2026 지방선거일 and excludes a non-holiday weekday', () => {
    expect(KR_HOLIDAYS.has('2026-06-03')).toBe(true); // 제9회 전국동시지방선거
    expect(KR_HOLIDAYS.has('2026-06-04')).toBe(false);
  });

  it('does NOT add a Monday substitute for 2026 추석 (ends Sat, no Sunday overlap)', () => {
    expect(KR_HOLIDAYS.has('2026-09-28')).toBe(false);
  });

  it('covers at least the current calendar year (annual-update staleness guard)', () => {
    // Fails once the bundled set stops covering "now" — i.e. the yearly update
    // was forgotten. Uses the real clock deliberately.
    expect(maxHolidayYear()).toBeGreaterThanOrEqual(new Date().getUTCFullYear());
  });
});

describe('makeIsHoliday (set algebra: (KR ∪ extra) \\ off)', () => {
  it('matches a bundled holiday on its KST date', () => {
    const isHoliday = makeIsHoliday();
    expect(isHoliday(new Date('2026-03-02T01:00:00Z'))).toBe(true); // 10:00 KST holiday
    expect(isHoliday(new Date('2026-06-01T01:00:00Z'))).toBe(false); // ordinary Monday
  });

  it('force-adds via extra and force-cancels via off', () => {
    const extra = new Set(['2026-07-04']);
    const off = new Set(['2026-03-02']);
    const isHoliday = makeIsHoliday(extra, off);
    expect(isHoliday(new Date('2026-07-04T01:00:00Z'))).toBe(true); // added
    expect(isHoliday(new Date('2026-03-02T01:00:00Z'))).toBe(false); // cancelled baseline
  });
});
