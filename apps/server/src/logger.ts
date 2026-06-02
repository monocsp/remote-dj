import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_SCHEMA, type LogEnv, type LogRecord, type LogStream } from '@remote-dj/shared';

// File-based structured logger. Two append-only JSONL streams (`ops`, `error`)
// under <logRoot>/<stream>/<YYYY-MM-DD>.jsonl. Dependency-free on purpose: the
// volume is low (a LAN app) and we want full control over the schema + dual
// streams + rotation without pino's worker-thread transports under tsx.
//
// Writes are SYNCHRONOUS (appendFileSync): at this volume the cost is negligible
// and it guarantees nothing is lost in a buffer on crash — and tests can read
// back immediately. See docs/LOGGING.md.

const MAX_BYTES = 20 * 1024 * 1024; // rotate within a day past 20MB
const RETENTION_DAYS: Record<LogStream, number> = { ops: 14, error: 60 };
// Hard disk ceiling per stream, enforced regardless of date (oldest deleted
// first when exceeded) — a backstop against floods within the retention window.
const MAX_STREAM_BYTES: Record<LogStream, number> = {
  ops: 200 * 1024 * 1024,
  error: 500 * 1024 * 1024,
};
// How often a long-running (always-on) server re-runs retention + the size
// ceiling. Startup-only pruning would never reclaim disk on a server that runs
// for weeks; 30 min keeps the disk cap responsive without churn.
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const STREAMS: LogStream[] = ['ops', 'error'];

/** Fields the caller supplies; the logger fills schema/env/ts. */
export type LogInput = Omit<LogRecord, 'schema' | 'env' | 'ts'> & { ts?: string };

export interface Logger {
  /** Write a fully-described record (stream/level/etc. provided by caller). */
  write(input: LogInput): void;
  close(): void;
}

/** UTC date as YYYY-MM-DD (log files roll on the UTC day boundary). */
function dayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** A logger that drops everything — the default for tests / library imports. */
export function createNoopLogger(): Logger {
  return { write: () => {}, close: () => {} };
}

/**
 * Create a file logger rooted at `logRoot`, tagging every record with `env`.
 * Prunes files older than the per-stream retention window on construction.
 */
export function createLogger(logRoot: string, env: LogEnv): Logger {
  // Per-stream cursor: which file we're appending to + its running byte count.
  type Cursor = { date: string; index: number; bytes: number; path: string };
  const cursors: Partial<Record<LogStream, Cursor>> = {};

  function filePath(stream: LogStream, date: string, index: number): string {
    const suffix = index > 1 ? `.${index}` : '';
    return join(logRoot, stream, `${date}${suffix}.jsonl`);
  }

  /** Resolve the file to append `lineBytes` to, rolling by day or size. */
  function cursorFor(stream: LogStream, lineBytes: number): Cursor {
    const today = dayStamp();
    const cur = cursors[stream];
    if (cur && cur.date === today && cur.bytes + lineBytes <= MAX_BYTES) return cur;
    const index = cur && cur.date === today ? cur.index + 1 : 1;
    mkdirSync(join(logRoot, stream), { recursive: true });
    const path = filePath(stream, today, index);
    const next: Cursor = { date: today, index, bytes: safeSize(path), path };
    cursors[stream] = next;
    return next;
  }

  function write(input: LogInput): void {
    const rec: LogRecord = {
      schema: LOG_SCHEMA,
      env,
      ts: input.ts ?? new Date().toISOString(),
      ...input,
    };
    let line: string;
    try {
      line = `${JSON.stringify(rec)}\n`;
    } catch {
      // Circular/oversized data → fall back to a minimal safe line.
      line = `${JSON.stringify({
        schema: LOG_SCHEMA,
        env,
        ts: rec.ts,
        stream: rec.stream,
        level: rec.level,
        occurredAt: rec.occurredAt,
        source: rec.source,
        runtime: rec.runtime,
        category: rec.category,
        event: rec.event,
        message: rec.message,
        error: { message: 'log payload was not serializable' },
      })}\n`;
    }
    try {
      const bytes = Buffer.byteLength(line);
      const cur = cursorFor(rec.stream, bytes);
      appendFileSync(cur.path, line);
      cur.bytes += bytes;
    } catch {
      // Never let logging crash the server.
    }
  }

  pruneOldFiles(logRoot);
  // Re-prune periodically so retention + the size ceiling hold on an always-on
  // server. unref() so this timer never keeps the process alive on its own.
  const sweep = setInterval(() => pruneOldFiles(logRoot), SWEEP_INTERVAL_MS);
  sweep.unref();
  return { write, close: () => clearInterval(sweep) };
}

/** File size in bytes, or 0 if the file does not exist yet. */
function safeSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Reclaim disk for each stream in two passes:
 *  1. delete files older than the per-stream retention window;
 *  2. if the stream dir still exceeds its byte ceiling, delete oldest-first
 *     until it's under (a hard backstop against floods within retention).
 */
function pruneOldFiles(logRoot: string): void {
  const now = Date.now();
  for (const stream of STREAMS) {
    const dir = join(logRoot, stream);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // dir not created yet
    }
    // Pass 1 — age-based retention.
    const maxAgeMs = RETENTION_DAYS[stream] * 24 * 60 * 60 * 1000;
    for (const name of names) {
      const m = name.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!m) continue;
      const fileDay = Date.parse(`${m[1]}T00:00:00.000Z`);
      if (Number.isNaN(fileDay)) continue;
      if (now - fileDay > maxAgeMs) {
        try {
          unlinkSync(join(dir, name));
        } catch {
          // ignore
        }
      }
    }
    // Pass 2 — total-size ceiling, oldest first (filenames sort chronologically).
    let survivors: { name: string; size: number }[];
    try {
      survivors = readdirSync(dir)
        .filter((n) => n.endsWith('.jsonl'))
        .map((n) => ({ name: n, size: safeSize(join(dir, n)) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }
    let total = survivors.reduce((sum, f) => sum + f.size, 0);
    const cap = MAX_STREAM_BYTES[stream];
    for (const f of survivors) {
      if (total <= cap) break;
      try {
        unlinkSync(join(dir, f.name));
        total -= f.size;
      } catch {
        // ignore
      }
    }
  }
}
