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
    await a.patchState('R1', {
      playlist: [{ id: 'x', url: 'u', title: null, addedBy: null, addedAt: 0, ownerId: '' }],
      currentIndex: 0,
    });
    a.flush();

    const b = new PersistentRoomStore(file);
    const record = await b.get('R1');
    expect(record).toBeDefined();
    expect(record?.state.volume).toBe(33);
    expect(record?.log).toEqual([{ id: 'a', ts: 1, actor: null, type: 'play', reason: null }]);
    expect(record?.state.playlist).toEqual([
      { id: 'x', url: 'u', title: null, addedBy: null, addedAt: 0, ownerId: '' },
    ]);
    expect(record?.state.currentIndex).toBe(0);
  });

  it('persists emptySince across instances and clears it via markOccupied', async () => {
    file = tmpFile();
    const a = new PersistentRoomStore(file);
    await a.getOrCreate('R1');
    await a.markEmpty('R1', 12345);
    // markEmpty only stamps when currently null — a second call must NOT overwrite.
    await a.markEmpty('R1', 99999);
    a.flush();

    const b = new PersistentRoomStore(file);
    expect((await b.get('R1'))?.emptySince).toBe(12345);
    await b.markOccupied('R1');
    b.flush();

    const c = new PersistentRoomStore(file);
    expect((await c.get('R1'))?.emptySince).toBeNull();
  });

  it('normalizes a legacy record with no emptySince to null (not instantly sweepable)', async () => {
    file = tmpFile();
    // A pre-sweep record on disk: a valid state but no emptySince key.
    writeFileSync(
      file,
      JSON.stringify({
        OLD: {
          state: { roomCode: 'OLD', playlist: [], currentIndex: -1 },
          log: [],
          password: null,
        },
      }),
      'utf8',
    );
    const store = new PersistentRoomStore(file);
    const rec = await store.get('OLD');
    expect(rec).toBeDefined();
    expect(rec?.emptySince).toBeNull();
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
