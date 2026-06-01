import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PersistentRoomStore } from './persistentStore.js';

function tmpFile(): string {
  return join(tmpdir(), `remote-dj-${randomUUID()}.json`);
}

describe('PersistentRoomStore', () => {
  let file: string;

  afterEach(() => {
    if (file) rmSync(file, { force: true });
  });

  it('round-trips room state across instances', async () => {
    file = tmpFile();

    const a = new PersistentRoomStore(file);
    await a.getOrCreate('R1');
    await a.patchState('R1', { volume: 33 });
    await a.appendActivity('R1', {
      id: 'a',
      ts: 1,
      actor: null,
      type: 'play',
      reason: null,
    });
    await a.setHistory('R1', [{ id: 'x', url: 'u', title: null, addedBy: null }]);
    a.flush();

    const b = new PersistentRoomStore(file);
    const record = await b.get('R1');
    expect(record).toBeDefined();
    expect(record?.state.volume).toBe(33);
    expect(record?.log).toEqual([{ id: 'a', ts: 1, actor: null, type: 'play', reason: null }]);
    expect(record?.history).toEqual([{ id: 'x', url: 'u', title: null, addedBy: null }]);
  });

  it('starts empty on a missing file without throwing', async () => {
    file = tmpFile();
    const store = new PersistentRoomStore(file);
    expect(await store.get('nope')).toBeUndefined();
  });

  it('starts empty on a corrupt file without throwing', async () => {
    file = tmpFile();
    writeFileSync(file, '{ this is not valid json', 'utf8');
    const store = new PersistentRoomStore(file);
    expect(await store.get('nope')).toBeUndefined();
  });
});
