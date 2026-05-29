import type { AddressInfo } from 'node:net';
import { type Ack, type ActivityEntry, C2S, LIMITS, type RoomState, S2C } from '@remote-dj/shared';
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

  it('isolates a socket that switched rooms from its old room broadcasts', async () => {
    const ROOM_A = 'ROOMAA';
    const ROOM_B = 'ROOMBB';
    const mover = connect();
    const stayer = connect();

    // mover joins A, then switches to B; stayer stays in A.
    await mover.emitWithAck(C2S.Join, { roomCode: ROOM_A, role: 'controller' });
    await stayer.emitWithAck(C2S.Join, { roomCode: ROOM_A, role: 'controller' });
    await mover.emitWithAck(C2S.Join, { roomCode: ROOM_B, role: 'controller' });

    // Any state the mover receives now must be for ROOM_B, never ROOM_A's track.
    let moverSawTrack = false;
    mover.on(S2C.State, (s: RoomState) => {
      if (s.currentTrack?.id === 'dQw4w9WgXcQ') moverSawTrack = true;
    });

    // stayer changes track in ROOM_A and should see it; mover must not.
    const stayerState = waitFor<RoomState>(
      stayer,
      S2C.State,
      (s) => s.currentTrack?.id === 'dQw4w9WgXcQ',
    );
    const ack = (await stayer.emitWithAck(C2S.ChangeTrack, {
      url: VALID_URL,
      reason: 'set the vibe',
    })) as Ack;
    expect(ack.ok).toBe(true);

    const s = await stayerState;
    expect(s.roomCode).toBe(ROOM_A);
    expect(moverSawTrack).toBe(false);
  });

  it('rejects changeTrack with an over-long reason', async () => {
    const room = 'ROOM05';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const ack = (await controller.emitWithAck(C2S.ChangeTrack, {
      url: VALID_URL,
      reason: 'x'.repeat(LIMITS.reason + 1),
    })) as Ack;
    expect(ack.ok).toBe(false);
  });

  it('bumps stateVersion after a successful setVolume', async () => {
    const room = 'ROOM06';
    const controller = connect();
    // Capture the state pushed during join (listener must be set up first).
    const joinState = waitFor<RoomState>(controller, S2C.State);
    const initial = (await controller.emitWithAck(C2S.Join, {
      roomCode: room,
      role: 'controller',
    })) as Ack;
    expect(initial.ok).toBe(true);

    const before = await joinState;

    const after = waitFor<RoomState>(
      controller,
      S2C.State,
      (st) => st.stateVersion > before.stateVersion,
    );
    const ack = (await controller.emitWithAck(C2S.SetVolume, { volume: 42 })) as Ack;
    expect(ack.ok).toBe(true);

    const state = await after;
    expect(state.stateVersion).toBeGreaterThan(before.stateVersion);
  });
});
