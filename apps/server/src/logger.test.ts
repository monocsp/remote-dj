import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

describe('logger', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rdj-log-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Read all JSONL records from a stream's files for today + any rolls. */
  function readStream(stream: 'ops' | 'error'): Record<string, unknown>[] {
    const dir = join(root, stream);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n'))
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it('writes ops and error records to separate stream files', () => {
    const log = createLogger(root, 'prd');
    log.write({
      stream: 'ops',
      level: 'info',
      occurredAt: '2026-06-02T00:00:00.000Z',
      source: 'server',
      runtime: 'node',
      category: 'room',
      event: 'room.join',
      message: 'joined',
    });
    log.write({
      stream: 'error',
      level: 'error',
      occurredAt: '2026-06-02T00:00:00.000Z',
      source: 'web',
      runtime: 'browser',
      category: 'runtime',
      event: 'runtime.error',
      message: 'boom',
      error: { name: 'TypeError', message: 'x' },
    });
    log.close();

    const ops = readStream('ops');
    const err = readStream('error');
    expect(ops).toHaveLength(1);
    expect(err).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      schema: 'remote-dj-log/v1',
      env: 'prd',
      stream: 'ops',
      event: 'room.join',
    });
    expect(ops[0].ts).toBeTypeOf('string'); // server-stamped
    expect(err[0]).toMatchObject({ stream: 'error', source: 'web' });
  });

  it('survives non-serializable data without throwing', () => {
    const log = createLogger(root, 'dev');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      log.write({
        stream: 'error',
        level: 'error',
        occurredAt: '2026-06-02T00:00:00.000Z',
        source: 'server',
        runtime: 'node',
        category: 'runtime',
        event: 'x',
        message: 'm',
        data: circular,
      }),
    ).not.toThrow();
    log.close();
    const err = readStream('error');
    expect(err).toHaveLength(1);
  });

  it('prunes log files older than the retention window on construction', () => {
    // An ops file dated 100 days ago (retention is 14 days) should be deleted.
    const opsDir = join(root, 'ops');
    mkdirSync(opsDir, { recursive: true });
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(opsDir, `${old}.jsonl`), '{}\n');
    writeFileSync(join(opsDir, `${today}.jsonl`), '{}\n');

    createLogger(root, 'dev').close();

    const remaining = readdirSync(opsDir);
    expect(remaining).toContain(`${today}.jsonl`);
    expect(remaining).not.toContain(`${old}.jsonl`);
  });
});
