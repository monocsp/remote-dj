import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WEB_LOG_PATH } from '@remote-dj/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from './index.js';
import { createLogger } from './logger.js';

describe('POST /internal/logs/web', () => {
  let root: string;
  let httpServer: HttpServer;
  let base: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'rdj-ingest-'));
    const logger = createLogger(root, 'prd');
    ({ httpServer } = createServer(undefined, undefined, undefined, undefined, logger));
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const { port } = httpServer.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });
  afterEach(() => {
    httpServer.close();
    rmSync(root, { recursive: true, force: true });
  });

  function readErrors(): Record<string, unknown>[] {
    const dir = join(root, 'error');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .flatMap((n) => readFileSync(join(dir, n), 'utf8').split('\n'))
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it('ingests a web error and writes it to the error stream, server-authored', async () => {
    const res = await fetch(`${base}${WEB_LOG_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({
        level: 'error',
        category: 'runtime',
        event: 'runtime.window_error',
        message: 'boom',
        occurredAt: '2026-06-02T00:00:00.000Z',
        route: '/controller?room=ABCDEF', // query must be stripped
        roomCode: 'ABCDEF',
        error: { name: 'TypeError', message: 'x' },
        // a secret-looking field that MUST be dropped
        data: { token: 'super-secret', ok: 1 },
        env: 'dev', // client-supplied env must be IGNORED (server forces prd)
      }),
    });
    expect(res.status).toBe(204);

    const errs = readErrors();
    expect(errs).toHaveLength(1);
    const rec = errs[0];
    expect(rec).toMatchObject({
      source: 'web',
      env: 'prd', // server overwrote the client's "dev"
      event: 'runtime.window_error',
      route: '/controller', // query stripped
    });
    expect(rec.requestId).toMatch(/^w_/);
    expect((rec.data as Record<string, unknown>).token).toBeUndefined(); // redacted
    expect((rec.data as Record<string, unknown>).ok).toBe(1);
  });

  it('accepts a batch array and rejects oversized bodies', async () => {
    const batch = await fetch(`${base}${WEB_LOG_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify([
        {
          level: 'error',
          category: 'runtime',
          event: 'a',
          message: 'a',
          occurredAt: '2026-06-02T00:00:00.000Z',
        },
        {
          level: 'warn',
          category: 'network',
          event: 'b',
          message: 'b',
          occurredAt: '2026-06-02T00:00:00.000Z',
        },
      ]),
    });
    expect(batch.status).toBe(204);

    const tooBig = await fetch(`${base}${WEB_LOG_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(70 * 1024),
    }).catch(() => null);
    // server destroys the socket past 64KB; either a 413 or a dropped connection.
    if (tooBig) expect([413, 400]).toContain(tooBig.status);
  });

  it('flood-limits repeated identical errors (≤5 per fingerprint per window)', async () => {
    const post = () =>
      fetch(`${base}${WEB_LOG_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({
          level: 'error',
          category: 'runtime',
          event: 'runtime.window_error',
          message: 'same boom',
          occurredAt: '2026-06-02T00:00:00.000Z',
          dedupeKey: 'flood-key',
          error: { name: 'TypeError', message: 'same boom' },
        }),
      });
    for (let i = 0; i < 12; i++) await post();
    // Only the first 5 in the window are written; the rest are dropped.
    const written = readErrors().filter((r) => r.fingerprint === 'flood-key');
    expect(written.length).toBe(5);
  });
});
