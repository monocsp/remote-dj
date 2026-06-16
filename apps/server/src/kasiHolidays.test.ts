import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  encodeServiceKey,
  ensureFreshHolidays,
  fetchKasiYear,
  parseKasiResponse,
} from './kasiHolidays.js';
import { createNoopLogger } from './logger.js';

// A fetch that fails the test if it is ever called (asserts "no network").
const failIfCalled = (async () => {
  throw new Error('fetch should not have been called');
}) as unknown as typeof fetch;
// A fetch returning a valid month body: January has a holiday, others empty.
const validFetch = (async (url: string) => {
  const mm = new URL(url).searchParams.get('solMonth');
  const item =
    mm === '01'
      ? { isHoliday: 'Y', locdate: 20260101 }
      : { isHoliday: 'N', locdate: `2026${mm}15` };
  return {
    ok: true,
    json: async () => ({ response: { header: { resultCode: '00' }, body: { items: { item } } } }),
  } as Response;
}) as unknown as typeof fetch;
async function seedCache(dates: string[], fetchedAt: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rdj-hol-'));
  const file = join(dir, 'holidays.json');
  await writeFile(file, JSON.stringify({ fetchedAt, years: [2026, 2027], dates }));
  return file;
}
const NOW = new Date('2026-06-16T00:00:00Z');
const OLD = '2020-01-01T00:00:00Z'; // > REFRESH_AFTER_DAYS old → stale

describe('encodeServiceKey', () => {
  it('URL-encodes a raw (decoding) key', () => {
    expect(encodeServiceKey('ab+cd/ef==')).toBe('ab%2Bcd%2Fef%3D%3D');
  });
  it('passes an already percent-encoded (encoding) key through unchanged', () => {
    expect(encodeServiceKey('ab%2Bcd%2Fef%3D%3D')).toBe('ab%2Bcd%2Fef%3D%3D');
  });
});

// A getRestDeInfo JSON body with a normal holiday, a 대체공휴일, and a non-holiday
// 절기 row (isHoliday=N) that must be filtered out.
const multi = {
  response: {
    header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' },
    body: {
      items: {
        item: [
          { dateKind: '01', dateName: '3·1절', isHoliday: 'Y', locdate: 20260301, seq: 1 },
          { dateKind: '01', dateName: '대체공휴일', isHoliday: 'Y', locdate: 20260302, seq: 1 },
          { dateKind: '03', dateName: '경칩', isHoliday: 'N', locdate: 20260305, seq: 1 },
        ],
      },
      numOfRows: 100,
      pageNo: 1,
      totalCount: 3,
    },
  },
};

describe('parseKasiResponse', () => {
  it('keeps isHoliday=Y rows as YYYY-MM-DD and drops isHoliday=N', () => {
    const set = parseKasiResponse(multi);
    expect([...set].sort()).toEqual(['2026-03-01', '2026-03-02']);
    expect(set.has('2026-03-05')).toBe(false); // 절기 (N)
  });

  it('handles a single-item (object, not array) body', () => {
    const single = {
      response: {
        header: { resultCode: '00' },
        body: { items: { item: { dateName: '신정', isHoliday: 'Y', locdate: 20260101 } } },
      },
    };
    expect([...parseKasiResponse(single)]).toEqual(['2026-01-01']);
  });

  it('returns empty for a 0-result body (items is "")', () => {
    const empty = {
      response: { header: { resultCode: '00' }, body: { items: '', totalCount: 0 } },
    };
    expect(parseKasiResponse(empty).size).toBe(0);
  });

  it('ignores malformed locdate values', () => {
    const bad = {
      response: {
        header: { resultCode: '00' },
        body: {
          items: {
            item: [
              { isHoliday: 'Y', locdate: '2026-3-1' },
              { isHoliday: 'Y', locdate: 'oops' },
            ],
          },
        },
      },
    };
    expect(parseKasiResponse(bad).size).toBe(0);
  });
});

describe('fetchKasiYear', () => {
  it('queries all 12 months and unions the holidays (injected fetch)', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(url);
      const mm = new URL(url).searchParams.get('solMonth');
      const item =
        mm === '03'
          ? { dateName: '3·1절', isHoliday: 'Y', locdate: 20260301 }
          : { isHoliday: 'N', locdate: `2026${mm}15` };
      return {
        ok: true,
        json: async () => ({
          response: { header: { resultCode: '00' }, body: { items: { item } } },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const set = await fetchKasiYear(2026, 'KEY', fakeFetch);
    expect(calls).toHaveLength(12);
    expect([...set]).toEqual(['2026-03-01']);
  });

  it('retries past a transient 401 from the gateway and recovers', async () => {
    let calls = 0;
    const fakeFetch = (async (url: string) => {
      calls++;
      if (calls === 1) return { ok: false, status: 401 } as Response; // first call flakes
      const mm = new URL(url).searchParams.get('solMonth');
      const item =
        mm === '01'
          ? { isHoliday: 'Y', locdate: 20260101 }
          : { isHoliday: 'N', locdate: `2026${mm}15` };
      return {
        ok: true,
        json: async () => ({
          response: { header: { resultCode: '00' }, body: { items: { item } } },
        }),
      } as Response;
    }) as unknown as typeof fetch;
    const set = await fetchKasiYear(2026, 'KEY', fakeFetch);
    expect(calls).toBe(13); // 1 retry + 12 months
    expect([...set]).toEqual(['2026-01-01']);
  });

  it('throws on a non-00 resultCode (e.g. unregistered key)', async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        json: async () => ({
          response: {
            header: { resultCode: '30', resultMsg: 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR' },
          },
        }),
      }) as Response) as unknown as typeof fetch;
    await expect(fetchKasiYear(2026, 'BAD', fakeFetch)).rejects.toThrow(/resultCode 30/);
  });

  it('throws when resultCode is missing (200 w/o header) — no silent empty success', async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        json: async () => ({ response: { body: {} } }),
      }) as Response) as unknown as typeof fetch;
    await expect(fetchKasiYear(2026, 'KEY', fakeFetch)).rejects.toThrow(/missing/);
  });
});

describe('ensureFreshHolidays', () => {
  it('does NOT call the network and stays static-only when no key', async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    let applied: ReadonlySet<string> | null = null;
    await ensureFreshHolidays({
      serviceKey: undefined,
      cacheFile: '/nonexistent/holidays.json',
      now: new Date('2026-06-16T00:00:00Z'),
      apply: (s) => {
        applied = s;
      },
      logger: createNoopLogger(),
      fetchImpl: fakeFetch,
    });
    expect(called).toBe(false); // no key → no API call
    expect(applied).toBeNull(); // no cache, nothing to apply
  });

  it('fetches + applies when a key is set and no cache exists', async () => {
    const fakeFetch = (async (url: string) => {
      const mm = new URL(url).searchParams.get('solMonth');
      const item =
        mm === '01'
          ? { isHoliday: 'Y', locdate: 20260101 }
          : { isHoliday: 'N', locdate: `2026${mm}15` };
      return {
        ok: true,
        json: async () => ({
          response: { header: { resultCode: '00' }, body: { items: { item } } },
        }),
      } as Response;
    }) as unknown as typeof fetch;
    let applied: ReadonlySet<string> | null = null;
    // Write the cache to a temp path so the persist step succeeds.
    const cacheFile = `${process.env.TMPDIR ?? '/tmp'}/rdj-holidays-test-${Math.floor(Date.now())}.json`;
    await ensureFreshHolidays({
      serviceKey: 'KEY',
      cacheFile,
      now: new Date('2026-06-16T00:00:00Z'),
      apply: (s) => {
        applied = s;
      },
      logger: createNoopLogger(),
      fetchImpl: fakeFetch,
    });
    expect(applied).not.toBeNull();
    expect((applied as unknown as Set<string>).has('2026-01-01')).toBe(true);
  });

  it('uses a fresh cache with ZERO network calls', async () => {
    const cacheFile = await seedCache(['2026-03-01'], NOW.toISOString());
    let applied: ReadonlySet<string> | null = null;
    await ensureFreshHolidays({
      serviceKey: 'KEY',
      cacheFile,
      now: NOW,
      apply: (s) => {
        applied = s;
      },
      logger: createNoopLogger(),
      fetchImpl: failIfCalled,
    });
    expect([...(applied as unknown as Set<string>)]).toEqual(['2026-03-01']);
  });

  it('with no key, applies an existing (even stale) cache without network', async () => {
    const cacheFile = await seedCache(['2026-03-01'], OLD);
    let applied: ReadonlySet<string> | null = null;
    await ensureFreshHolidays({
      serviceKey: undefined,
      cacheFile,
      now: NOW,
      apply: (s) => {
        applied = s;
      },
      logger: createNoopLogger(),
      fetchImpl: failIfCalled,
    });
    expect([...(applied as unknown as Set<string>)]).toEqual(['2026-03-01']);
  });

  it('keeps the last-good cache when the fetch throws (fail-soft)', async () => {
    const cacheFile = await seedCache(['2026-03-01'], OLD); // stale → triggers a fetch
    const throwing = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    let applied: ReadonlySet<string> | null = null;
    await ensureFreshHolidays({
      serviceKey: 'KEY',
      cacheFile,
      now: NOW,
      apply: (s) => {
        applied = s;
      },
      logger: createNoopLogger(),
      fetchImpl: throwing,
    });
    expect([...(applied as unknown as Set<string>)]).toEqual(['2026-03-01']);
    expect(JSON.parse(await readFile(cacheFile, 'utf8')).dates).toEqual(['2026-03-01']);
  });

  it('refuses to overwrite the cache with an empty fetch (poisoning guard)', async () => {
    const cacheFile = await seedCache(['2026-03-01'], OLD); // stale → triggers a fetch
    const emptyFetch = (async (url: string) => {
      const mm = new URL(url).searchParams.get('solMonth');
      return {
        ok: true,
        json: async () => ({
          response: {
            header: { resultCode: '00' },
            body: { items: { item: { isHoliday: 'N', locdate: `2026${mm}15` } } },
          },
        }),
      } as Response;
    }) as unknown as typeof fetch;
    let applied: ReadonlySet<string> | null = null;
    await ensureFreshHolidays({
      serviceKey: 'KEY',
      cacheFile,
      now: NOW,
      apply: (s) => {
        applied = s;
      },
      logger: createNoopLogger(),
      fetchImpl: emptyFetch,
    });
    expect([...(applied as unknown as Set<string>)]).toEqual(['2026-03-01']); // kept last-good
    expect(JSON.parse(await readFile(cacheFile, 'utf8')).dates).toEqual(['2026-03-01']); // NOT clobbered
  });

  it('atomically writes the cache, creating a missing directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rdj-hol-'));
    const cacheFile = join(dir, 'nested', 'holidays.json'); // 'nested' does not exist yet
    await ensureFreshHolidays({
      serviceKey: 'KEY',
      cacheFile,
      now: NOW,
      apply: () => {},
      logger: createNoopLogger(),
      fetchImpl: validFetch,
    });
    const onDisk = JSON.parse(await readFile(cacheFile, 'utf8'));
    expect(onDisk.dates).toContain('2026-01-01');
    expect(onDisk.years).toEqual([2026, 2027]);
  });
});
