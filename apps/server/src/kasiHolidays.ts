// Phase 2 (optional): official KR public-holiday data from the KASI 특일정보
// service, used to AUGMENT the bundled static set in holidays.ts. Gated behind
// DATA_GO_KR_SERVICE_KEY — when absent/unreachable the server runs on the static
// set alone. Designed for MINIMAL API usage: the result is persisted to disk
// (the server "DB", next to rooms.json) and only re-fetched ~once a year (when
// the cache stops covering the needed years or ages past ~300 days), never from
// the schedule hot path.
//
// Endpoint (KASI / data.go.kr, doc OA_DV_0401):
//   GET …/SpcdeInfoService/getRestDeInfo?solYear=YYYY&solMonth=MM
//       &numOfRows=100&_type=json&ServiceKey=<DECODED KEY>
// Response items carry locdate (YYYYMMDD) + isHoliday (Y/N); we keep isHoliday=Y.
// 대체공휴일·임시공휴일 come back as resolved solar dates, so this auto-captures
// exactly the cases the hand-maintained static list can miss.

import { readFile, writeFile } from 'node:fs/promises';
import { isYmd, kstParts } from './holidays.js';
import type { Logger } from './logger.js';

const KASI_BASE = 'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo';

/**
 * data.go.kr issues the service key in two forms and tells you to "use whichever
 * works": a "Decoding" key (raw, must be URL-encoded) and an "Encoding" key
 * (already percent-encoded, pass as-is). Accept either — if it already looks
 * percent-encoded, pass it through; otherwise URL-encode it.
 */
export function encodeServiceKey(serviceKey: string): string {
  return /%[0-9A-Fa-f]{2}/.test(serviceKey) ? serviceKey : encodeURIComponent(serviceKey);
}

// Re-fetch when the cache is older than this even if year coverage still holds —
// catches a mid-year 임시공휴일 the next time the server boots/ticks. Kept near a
// year to honour the "minimal API usage / yearly update" requirement.
const REFRESH_AFTER_DAYS = 300;

export interface HolidayCache {
  fetchedAt: string; // ISO timestamp of the last successful fetch
  years: number[]; // calendar years this snapshot covers
  dates: string[]; // "YYYY-MM-DD" holiday dates (isHoliday=Y)
}

/** Parse a getRestDeInfo JSON body into a Set of "YYYY-MM-DD" holiday dates. */
// biome-ignore lint/suspicious/noExplicitAny: external API shape is dynamic JSON.
export function parseKasiResponse(json: any): Set<string> {
  const out = new Set<string>();
  const items = json?.response?.body?.items?.item;
  if (!items) return out; // 0 results → items is "" or undefined
  const arr = Array.isArray(items) ? items : [items]; // 1 result → object, not array
  for (const it of arr) {
    if (
      String(it?.isHoliday ?? '')
        .trim()
        .toUpperCase() !== 'Y'
    )
      continue;
    const loc = String(it?.locdate ?? '').trim();
    if (!/^\d{8}$/.test(loc)) continue;
    const ymd = `${loc.slice(0, 4)}-${loc.slice(4, 6)}-${loc.slice(6, 8)}`;
    if (isYmd(ymd)) out.add(ymd);
  }
  return out;
}

/**
 * Fetch every public holiday for `year` by querying months 1–12 (solMonth is a
 * required param per the spec) and unioning the results. Throws on HTTP failure
 * or a non-"00" resultCode (e.g. an unregistered/over-quota key) so the caller
 * can fall back to the cache/static set.
 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// data.go.kr's HTTPS gateway intermittently returns 401/5xx on otherwise-valid
// requests; retry a few times with a short backoff so the once-a-year refresh
// isn't defeated by transient edge flakiness. A non-401 4xx fails fast.
async function fetchOk(url: string, fetchImpl: typeof fetch, label: string): Promise<Response> {
  let status = 0;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetchImpl(url);
    if (res.ok) return res;
    status = res.status;
    if (attempt < 4 && (res.status === 401 || res.status >= 500)) {
      await sleep(300 * attempt);
      continue;
    }
    break;
  }
  throw new Error(`KASI HTTP ${status} (${label})`);
}

export async function fetchKasiYear(
  year: number,
  serviceKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Set<string>> {
  const out = new Set<string>();
  const keyParam = encodeServiceKey(serviceKey);
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const url =
      `${KASI_BASE}?solYear=${year}&solMonth=${mm}` +
      `&numOfRows=100&_type=json&ServiceKey=${keyParam}`;
    const res = await fetchOk(url, fetchImpl, `${year}-${mm}`);
    // biome-ignore lint/suspicious/noExplicitAny: external API shape is dynamic JSON.
    const json: any = await res.json();
    const code = json?.response?.header?.resultCode;
    if (code && code !== '00') {
      throw new Error(
        `KASI resultCode ${code}: ${json?.response?.header?.resultMsg} (${year}-${mm})`,
      );
    }
    for (const d of parseKasiResponse(json)) out.add(d);
  }
  return out;
}

function ageDays(iso: string, now: Date): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - t) / 86_400_000;
}

async function readCache(file: string): Promise<HolidayCache | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (
      parsed &&
      typeof parsed.fetchedAt === 'string' &&
      Array.isArray(parsed.years) &&
      Array.isArray(parsed.dates)
    ) {
      return parsed as HolidayCache;
    }
  } catch {
    // missing / unreadable / malformed → no cache
  }
  return null;
}

/**
 * Ensure the dynamic holiday set is fresh, doing the LEAST possible work:
 *  - cache covers [thisYear, nextYear] AND is younger than REFRESH_AFTER_DAYS
 *      → apply cache, NO network.
 *  - no serviceKey → apply whatever cache exists (even stale; static still
 *      backs it via union), NO network.
 *  - otherwise → fetch the needed years from KASI, persist to `cacheFile`,
 *      apply. On any fetch error, fall back to the last-good cache (or nothing,
 *      i.e. static-only) and log a warning.
 * `apply(set)` swaps the live set the scheduler reads. Never throws.
 */
export async function ensureFreshHolidays(opts: {
  serviceKey: string | undefined;
  cacheFile: string;
  now: Date;
  apply: (dates: ReadonlySet<string>) => void;
  logger: Logger;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { serviceKey, cacheFile, now, apply, logger, fetchImpl } = opts;
  const log = (
    level: 'info' | 'warn',
    event: string,
    message: string,
    data?: Record<string, unknown>,
  ) =>
    logger.write({
      stream: 'ops',
      level,
      occurredAt: new Date().toISOString(),
      source: 'server',
      runtime: 'node',
      category: 'settings',
      event,
      message,
      data,
    });

  const year = Number(kstParts(now).date.slice(0, 4));
  const needed = [year, year + 1];
  const cache = await readCache(cacheFile);
  const covers = (c: HolidayCache) => needed.every((y) => c.years.includes(y));

  if (cache && covers(cache) && ageDays(cache.fetchedAt, now) < REFRESH_AFTER_DAYS) {
    apply(new Set(cache.dates));
    log('info', 'holiday.kasi_cache', 'using cached KASI holidays (fresh)', {
      count: cache.dates.length,
      years: cache.years,
      ageDays: Math.round(ageDays(cache.fetchedAt, now)),
    });
    return;
  }

  if (!serviceKey) {
    if (cache) {
      apply(new Set(cache.dates));
      log(
        'warn',
        'holiday.kasi_nokey_cache',
        'no DATA_GO_KR_SERVICE_KEY — using stale cache + static',
        {
          years: cache.years,
          ageDays: Math.round(ageDays(cache.fetchedAt, now)),
        },
      );
    } else {
      log('info', 'holiday.kasi_disabled', 'no DATA_GO_KR_SERVICE_KEY — static holiday set only');
    }
    return;
  }

  try {
    const merged = new Set<string>();
    for (const y of needed) {
      for (const d of await fetchKasiYear(y, serviceKey, fetchImpl)) merged.add(d);
    }
    const snapshot: HolidayCache = {
      fetchedAt: now.toISOString(),
      years: needed,
      dates: [...merged].sort(),
    };
    await writeFile(cacheFile, JSON.stringify(snapshot, null, 2));
    apply(merged);
    log('info', 'holiday.kasi_refresh', 'refreshed holidays from KASI', {
      count: merged.size,
      years: needed,
    });
  } catch (err) {
    if (cache) {
      apply(new Set(cache.dates));
      log('warn', 'holiday.kasi_fetch_failed', 'KASI fetch failed — kept last-good cache', {
        error: err instanceof Error ? err.message : String(err),
        years: cache.years,
      });
    } else {
      log('warn', 'holiday.kasi_fetch_failed', 'KASI fetch failed — static holiday set only', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
