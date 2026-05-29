import type { AddressInfo } from 'node:net';
import { type Ack, type ActivityEntry, C2S, type RoomState, S2C } from '@remote-dj/shared';
import { type Socket as ClientSocket, io as ioClient } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from './index.js';

const VALID_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

// Listen until a payload matching `predicate` arrives (ignoring stray
// earlier emits, e.g. presence broadcasts from other clients' joins).
function waitFor<T = unknown>(
  socket: ClientSocket,
  event: string,
  predicate?: (payload: T) => boolean,
): Promise<T> {
  return new Promise((resolve) => {
    const handler = (payload: T) => {
      if (!predicate || predicate(payload)) {
        socket.off(event, handler);
        resolve(payload);
      }
    };
    socket.on(event, handler);
  });
}

describe('remote-dj server', () => {
  let io: ReturnType<typeof createServer>['io'];
  let httpServer: ReturnType<typeof createServer>['httpServer'];
  let port: number;
  const clients: ClientSocket[] = [];

  function connect(): ClientSocket {
    const socket = ioClient(`http://127.0.0.1:${port}`, { forceNew: true });
    clients.push(socket);
    return socket;
  }

  beforeEach(async () => {
    ({ io, httpServer } = createServer());
    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const c of clients) c.disconnect();
    clients.length = 0;
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('rejects changeTrack with empty reason', async () => {
    const controller = connect();
    const joinAck = await controller.emitWithAck(C2S.Join, {
      roomCode: 'ROOM01',
      role: 'controller',
    });
    expect((joinAck as Ack).ok).toBe(true);

    const ack = (await controller.emitWithAck(C2S.ChangeTrack, {
      url: VALID_URL,
      reason: '   ',
    })) as Ack;
    expect(ack.ok).toBe(false);
  });

  it('broadcasts state + activity on a valid changeTrack', async () => {
    const room = 'ROOM02';
    const controller = connect();
    const otherController = connect();
    const player = connect();

    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await otherController.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const hasTrack = (s: RoomState) => s.currentTrack?.id === 'dQw4w9WgXcQ';
    const isTrackChange = (a: ActivityEntry) => a.type === 'track_change';
    const otherState = waitFor<RoomState>(otherController, S2C.State, hasTrack);
    const playerState = waitFor<RoomState>(player, S2C.State, hasTrack);
    const otherActivity = waitFor<ActivityEntry>(otherController, S2C.Activity, isTrackChange);
    const playerActivity = waitFor<ActivityEntry>(player, S2C.Activity, isTrackChange);

    const ack = (await controller.emitWithAck(C2S.ChangeTrack, {
      url: VALID_URL,
      reason: 'set the vibe',
      title: 'Never Gonna Give You Up',
    })) as Ack;
    expect(ack.ok).toBe(true);

    const [os, ps, oa, pa] = await Promise.all([
      otherState,
      playerState,
      otherActivity,
      playerActivity,
    ]);

    expect(os.currentTrack?.id).toBe('dQw4w9WgXcQ');
    expect(ps.currentTrack?.id).toBe('dQw4w9WgXcQ');
    expect(oa.type).toBe('track_change');
    expect(pa.type).toBe('track_change');
  });

  it('clamps an out-of-range volume to 100', async () => {
    const room = 'ROOM03';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const statePromise = waitFor<RoomState>(controller, S2C.State);
    const ack = (await controller.emitWithAck(C2S.SetVolume, { volume: 150 })) as Ack;
    expect(ack.ok).toBe(true);

    const state = await statePromise;
    expect(state.volume).toBe(100);
  });

  it('rejects control events from a player', async () => {
    const room = 'ROOM04';
    const player = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const ack = (await player.emitWithAck(C2S.ChangeTrack, {
      url: VALID_URL,
      reason: 'i want this',
    })) as Ack;
    expect(ack.ok).toBe(false);
  });
});
