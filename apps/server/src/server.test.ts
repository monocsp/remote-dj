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
  let tick: (now: Date) => Promise<void>;
  let port: number;
  const clients: ClientSocket[] = [];

  function connect(): ClientSocket {
    const socket = ioClient(`http://127.0.0.1:${port}`, { forceNew: true });
    clients.push(socket);
    return socket;
  }

  beforeEach(async () => {
    // Stub the title + loudness resolvers so tests never hit the network and
    // are deterministic (keep the default in-memory store). The loudness stub
    // returns null so loudness auto-seed is a no-op in most tests; GAIN-03/04
    // create their own server with a loud stub.
    ({
      io,
      httpServer,
      tickSchedules: tick,
    } = createServer(
      undefined,
      async () => 'Stub Title',
      async () => null,
    ));
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

  it('rejects joining a password-protected room with the wrong password', async () => {
    const room = 'ROOMPW';
    const creator = connect();
    const createAck = (await creator.emitWithAck(C2S.Join, {
      roomCode: room,
      role: 'controller',
      password: 'secret',
    })) as Ack;
    expect(createAck.ok).toBe(true);

    const second = connect();
    const ack = (await second.emitWithAck(C2S.Join, {
      roomCode: room,
      role: 'controller',
      password: 'nope',
    })) as Ack;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('wrong password');
  });

  it('allows joining a password-protected room with the correct password', async () => {
    const room = 'ROOMPX';
    const creator = connect();
    await creator.emitWithAck(C2S.Join, {
      roomCode: room,
      role: 'controller',
      password: 'secret',
    });

    const second = connect();
    const ack = (await second.emitWithAck(C2S.Join, {
      roomCode: room,
      role: 'player',
      password: 'secret',
    })) as Ack;
    expect(ack.ok).toBe(true);
  });

  it('ignores a password when joining an open room', async () => {
    const room = 'ROOMOP';
    const creator = connect();
    await creator.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const second = connect();
    const ack = (await second.emitWithAck(C2S.Join, {
      roomCode: room,
      role: 'controller',
      password: 'whatever',
    })) as Ack;
    expect(ack.ok).toBe(true);
  });

  it('rejects an over-long password on join', async () => {
    const room = 'ROOMPL';
    const creator = connect();
    const ack = (await creator.emitWithAck(C2S.Join, {
      roomCode: room,
      role: 'controller',
      password: 'x'.repeat(LIMITS.password + 1),
    })) as Ack;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('password too long');
  });

  it('propagates lastSeek to OTHER room members (separate observer)', async () => {
    const room = 'ROOMSK';
    const observer = connect();
    const controller = connect();
    await observer.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const obsState = waitFor<RoomState>(observer, S2C.State, (s) => s.lastSeek?.seconds === 37);
    const ack = (await controller.emitWithAck(C2S.SeekTo, { seconds: 37 })) as Ack;
    expect(ack.ok).toBe(true);

    const s = await obsState;
    expect(s.lastSeek?.seconds).toBe(37);
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

  it('enqueue adds the track to broadcast state.queue and logs enqueue', async () => {
    const room = 'QUEUE1';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const hasQueued = (s: RoomState) => s.queue.some((t) => t.id === 'dQw4w9WgXcQ');
    const isEnqueue = (a: ActivityEntry) => a.type === 'enqueue';
    const playerState = waitFor<RoomState>(player, S2C.State, hasQueued);
    const playerActivity = waitFor<ActivityEntry>(player, S2C.Activity, isEnqueue);

    const ack = (await controller.emitWithAck(C2S.EnqueueTrack, {
      url: VALID_URL,
      title: 'Never Gonna Give You Up',
    })) as Ack;
    expect(ack.ok).toBe(true);

    const [ps, pa] = await Promise.all([playerState, playerActivity]);
    expect(ps.queue[0]?.id).toBe('dQw4w9WgXcQ');
    expect(ps.currentTrack).toBeNull();
    expect(pa.type).toBe('enqueue');
  });

  it('nextTrack advances currentTrack to the queued item and shrinks the queue', async () => {
    const room = 'QUEUE2';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    await controller.emitWithAck(C2S.EnqueueTrack, { url: VALID_URL });

    const advanced = waitFor<RoomState>(
      controller,
      S2C.State,
      (s) => s.currentTrack?.id === 'dQw4w9WgXcQ',
    );
    const ack = (await controller.emitWithAck(C2S.NextTrack, {})) as Ack;
    expect(ack.ok).toBe(true);

    const state = await advanced;
    expect(state.currentTrack?.id).toBe('dQw4w9WgXcQ');
    expect(state.queue.length).toBe(0);
    expect(state.isPlaying).toBe(true);
  });

  it('nextTrack on an empty queue is a no-op ok', async () => {
    const room = 'QUEUE3';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const ack = (await controller.emitWithAck(C2S.NextTrack, {})) as Ack;
    expect(ack.ok).toBe(true);
  });

  it('removeQueued with an out-of-range index acks false', async () => {
    const room = 'QUEUE4';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const ack = (await controller.emitWithAck(C2S.RemoveQueued, { index: 5 })) as Ack;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('invalid index');
  });

  it('trackEnded from a player advances the queue', async () => {
    const room = 'QUEUE5';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    await controller.emitWithAck(C2S.EnqueueTrack, { url: VALID_URL });

    const advanced = waitFor<RoomState>(
      player,
      S2C.State,
      (s) => s.currentTrack?.id === 'dQw4w9WgXcQ',
    );
    const ack = (await player.emitWithAck(C2S.TrackEnded, {})) as Ack;
    expect(ack.ok).toBe(true);

    const state = await advanced;
    expect(state.currentTrack?.id).toBe('dQw4w9WgXcQ');
    expect(state.queue.length).toBe(0);
  });

  it('rejects enqueue and nextTrack from a player (controller-only)', async () => {
    const room = 'QUEUE6';
    const player = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const enqAck = (await player.emitWithAck(C2S.EnqueueTrack, { url: VALID_URL })) as Ack;
    expect(enqAck.ok).toBe(false);

    const nextAck = (await player.emitWithAck(C2S.NextTrack, {})) as Ack;
    expect(nextAck.ok).toBe(false);
  });

  it('rejects trackEnded from a controller (player-only)', async () => {
    const room = 'QUEUE7';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const ack = (await controller.emitWithAck(C2S.TrackEnded, {})) as Ack;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('player only');
  });

  it('seekTo by a controller broadcasts lastSeek and logs a seek activity', async () => {
    const room = 'SEEK1';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const hasSeek = (s: RoomState) => s.lastSeek?.seconds === 42;
    const isSeek = (a: ActivityEntry) => a.type === 'seek';
    const playerState = waitFor<RoomState>(player, S2C.State, hasSeek);
    const playerActivity = waitFor<ActivityEntry>(player, S2C.Activity, isSeek);

    const ack = (await controller.emitWithAck(C2S.SeekTo, { seconds: 42 })) as Ack;
    expect(ack.ok).toBe(true);

    const [ps, pa] = await Promise.all([playerState, playerActivity]);
    expect(ps.lastSeek?.seconds).toBe(42);
    expect(pa.type).toBe('seek');
    expect((pa.detail as { seconds: number }).seconds).toBe(42);
  });

  it('rejects seekTo with negative seconds', async () => {
    const room = 'SEEK2';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const ack = (await controller.emitWithAck(C2S.SeekTo, { seconds: -5 })) as Ack;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('invalid seconds');
  });

  it('rejects seekTo from a player (controller-only)', async () => {
    const room = 'SEEK3';
    const player = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const ack = (await player.emitWithAck(C2S.SeekTo, { seconds: 10 })) as Ack;
    expect(ack.ok).toBe(false);
  });

  it('progress from a player updates state.progress and logs no activity', async () => {
    const room = 'SEEK4';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // Set a current track first so progress can be stamped with its id.
    const hasTrack = waitFor<RoomState>(
      player,
      S2C.State,
      (s) => s.currentTrack?.id === 'dQw4w9WgXcQ',
    );
    await controller.emitWithAck(C2S.ChangeTrack, { url: VALID_URL, reason: 'X' });
    await hasTrack;

    // Progress must NOT produce an activity entry.
    let sawActivity = false;
    controller.on(S2C.Activity, () => {
      sawActivity = true;
    });

    const hasProgress = (s: RoomState) => s.progress?.currentTime === 12;
    const controllerState = waitFor<RoomState>(controller, S2C.State, hasProgress);

    const ack = (await player.emitWithAck(C2S.Progress, {
      currentTime: 12,
      duration: 200,
    })) as Ack;
    expect(ack.ok).toBe(true);

    const cs = await controllerState;
    expect(cs.progress?.currentTime).toBe(12);
    expect(cs.progress?.duration).toBe(200);
    // The server stamps the progress with the current track's id.
    expect(cs.progress?.id).toBe('dQw4w9WgXcQ');
    expect(sawActivity).toBe(false);
  });

  it('rejects progress from a controller (player-only)', async () => {
    const room = 'SEEK5';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const ack = (await controller.emitWithAck(C2S.Progress, {
      currentTime: 1,
      duration: 100,
    })) as Ack;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('player only');
  });

  // ── SET-xx: settings / allowAnonymous enforcement ──────────────────────────

  it('SET-01 updateSettings broadcasts new settings + logs a settings activity', async () => {
    const room = 'SET01';
    const controller = connect();
    const observer = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await observer.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const settingsOff = (s: RoomState) => s.settings.allowAnonymous === false;
    const isSettings = (a: ActivityEntry) => a.type === 'settings';
    const obsState = waitFor<RoomState>(observer, S2C.State, settingsOff);
    const obsActivity = waitFor<ActivityEntry>(observer, S2C.Activity, isSettings);

    const ack = (await controller.emitWithAck(C2S.UpdateSettings, {
      settings: { allowAnonymous: false },
    })) as Ack;
    expect(ack.ok).toBe(true);

    const [os, oa] = await Promise.all([obsState, obsActivity]);
    expect(os.settings.allowAnonymous).toBe(false);
    expect(oa.type).toBe('settings');
  });

  it('SET-02 rejects an anonymous controller changeTrack when allowAnonymous=false', async () => {
    const room = 'SET02';
    const controller = connect(); // joins WITHOUT a nickname → anonymous
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const settingsAck = (await controller.emitWithAck(C2S.UpdateSettings, {
      settings: { allowAnonymous: false },
    })) as Ack;
    expect(settingsAck.ok).toBe(true);

    const ack = (await controller.emitWithAck(C2S.ChangeTrack, {
      url: VALID_URL,
      reason: 'set the vibe',
    })) as Ack;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('nickname required');
  });

  it('SET-03 allows a controller WITH a nickname to changeTrack when allowAnonymous=false', async () => {
    const room = 'SET03';
    const named = connect();
    const anon = connect();
    // A named controller flips the setting; a different anon controller can't,
    // but the named one can still change tracks.
    await named.emitWithAck(C2S.Join, { roomCode: room, role: 'controller', nickname: 'dj' });
    await anon.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const settingsAck = (await named.emitWithAck(C2S.UpdateSettings, {
      settings: { allowAnonymous: false },
    })) as Ack;
    expect(settingsAck.ok).toBe(true);

    const hasTrack = (s: RoomState) => s.currentTrack?.id === 'dQw4w9WgXcQ';
    const namedState = waitFor<RoomState>(named, S2C.State, hasTrack);

    const ack = (await named.emitWithAck(C2S.ChangeTrack, {
      url: VALID_URL,
      reason: 'i have a nickname',
    })) as Ack;
    expect(ack.ok).toBe(true);

    const s = await namedState;
    expect(s.currentTrack?.id).toBe('dQw4w9WgXcQ');
  });

  it('SET-04 setVolume from an anonymous controller still works when allowAnonymous=false (not gated)', async () => {
    const room = 'SET04';
    const controller = connect(); // anonymous
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const settingsAck = (await controller.emitWithAck(C2S.UpdateSettings, {
      settings: { allowAnonymous: false },
    })) as Ack;
    expect(settingsAck.ok).toBe(true);

    const hasVolume = (s: RoomState) => s.volume === 42;
    const statePromise = waitFor<RoomState>(controller, S2C.State, hasVolume);

    const ack = (await controller.emitWithAck(C2S.SetVolume, { volume: 42 })) as Ack;
    expect(ack.ok).toBe(true);

    const state = await statePromise;
    expect(state.volume).toBe(42);
  });

  // ── ERR-xx: YouTube playback error / recovery ───────────────────────────────

  it('ERR-01 a player playbackError sets broadcast state.playbackError.code', async () => {
    const room = 'ERR01';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const hasError = (s: RoomState) => s.playbackError?.code === 100;
    const controllerState = waitFor<RoomState>(controller, S2C.State, hasError);

    const ack = (await player.emitWithAck(C2S.PlaybackError, { code: 100 })) as Ack;
    expect(ack.ok).toBe(true);

    const cs = await controllerState;
    expect(cs.playbackError?.code).toBe(100);
  });

  it('ERR-02 a subsequent changeTrack clears playbackError to null', async () => {
    const room = 'ERR02';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const errored = waitFor<RoomState>(controller, S2C.State, (s) => s.playbackError?.code === 100);
    const errAck = (await player.emitWithAck(C2S.PlaybackError, { code: 100 })) as Ack;
    expect(errAck.ok).toBe(true);
    await errored;

    const cleared = waitFor<RoomState>(
      controller,
      S2C.State,
      (s) => s.currentTrack?.id === 'dQw4w9WgXcQ',
    );
    const ack = (await controller.emitWithAck(C2S.ChangeTrack, {
      url: VALID_URL,
      reason: 'recover',
    })) as Ack;
    expect(ack.ok).toBe(true);

    const cs = await cleared;
    expect(cs.playbackError).toBeNull();
  });

  it('ERR-03 rejects playbackError from a controller (player-only)', async () => {
    const room = 'ERR03';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const ack = (await controller.emitWithAck(C2S.PlaybackError, { code: 100 })) as Ack;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('player only');
  });

  // ── GAP coverage (docs/TESTING.md §4) ───────────────────────────────────────

  it('RT-04 decrements presence.controllers when a controller disconnects', async () => {
    const room = 'RT04';
    const controllerA = connect();
    const controllerB = connect();
    await controllerA.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await controllerB.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    // After A leaves, B must receive a state with exactly one controller.
    const dropped = waitFor<RoomState>(controllerB, S2C.State, (s) => s.presence.controllers === 1);
    controllerA.disconnect();

    const s = await dropped;
    expect(s.presence.controllers).toBe(1);
    expect(s.presence.playerConnected).toBe(false);
  });

  it('RT-06 a fresh socket joining a room resyncs to current track + activity log', async () => {
    const room = 'RT06';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const ack = (await controller.emitWithAck(C2S.ChangeTrack, {
      url: VALID_URL,
      reason: 'set the vibe',
      title: 'Never Gonna Give You Up',
    })) as Ack;
    expect(ack.ok).toBe(true);

    // A brand-new socket joins the SAME room and must receive both the latest
    // state (with currentTrack) and the full activity log on join.
    const fresh = connect();
    const freshState = waitFor<RoomState>(
      fresh,
      S2C.State,
      (s) => s.currentTrack?.id === 'dQw4w9WgXcQ',
    );
    const freshLog = waitFor<ActivityEntry[]>(fresh, S2C.ActivityLog, (log) =>
      log.some((e) => e.type === 'track_change'),
    );

    const joinAck = (await fresh.emitWithAck(C2S.Join, {
      roomCode: room,
      role: 'controller',
    })) as Ack;
    expect(joinAck.ok).toBe(true);

    const [s, log] = await Promise.all([freshState, freshLog]);
    expect(s.currentTrack?.id).toBe('dQw4w9WgXcQ');
    expect(log.some((e) => e.type === 'track_change')).toBe(true);
  });

  it('QUEUE-13 removeQueued at index 0 drops the head and keeps the rest', async () => {
    const room = 'QUEUE13';
    const SECOND_URL = 'https://youtu.be/9bZkp7q19f0';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    await controller.emitWithAck(C2S.EnqueueTrack, { url: VALID_URL });
    await controller.emitWithAck(C2S.EnqueueTrack, { url: SECOND_URL });

    const shrunk = waitFor<RoomState>(
      controller,
      S2C.State,
      (s) => s.queue.length === 1 && s.queue[0]?.id === '9bZkp7q19f0',
    );
    const ack = (await controller.emitWithAck(C2S.RemoveQueued, { index: 0 })) as Ack;
    expect(ack.ok).toBe(true);

    const s = await shrunk;
    expect(s.queue.length).toBe(1);
    expect(s.queue[0]?.id).toBe('9bZkp7q19f0');
  });

  it('SEEK-09 rejects a progress report with non-finite or negative currentTime', async () => {
    const room = 'SEEK09';
    const player = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const nanAck = (await player.emitWithAck(C2S.Progress, {
      currentTime: Number.NaN,
      duration: 100,
    })) as Ack;
    expect(nanAck.ok).toBe(false);

    const negAck = (await player.emitWithAck(C2S.Progress, {
      currentTime: -1,
      duration: 100,
    })) as Ack;
    expect(negAck.ok).toBe(false);
  });

  it('ERR-04 rejects a playbackError whose code is not a number', async () => {
    const room = 'ERR04';
    const player = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const ack = (await player.emitWithAck(C2S.PlaybackError, { code: 'x' })) as Ack;
    expect(ack.ok).toBe(false);
  });

  it('TITLE-01 fills currentTrack.title from the resolver when no title is given', async () => {
    const room = 'TITLE1';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    // The first state (from the ack/broadcast) may carry title null; the
    // predicate waits for the enriched re-broadcast.
    const enriched = waitFor<RoomState>(
      controller,
      S2C.State,
      (s) => s.currentTrack?.title === 'Stub Title',
    );
    const ack = (await controller.emitWithAck(C2S.ChangeTrack, {
      url: VALID_URL,
      reason: 'set the vibe',
    })) as Ack;
    expect(ack.ok).toBe(true);

    const s = await enriched;
    expect(s.currentTrack?.title).toBe('Stub Title');
  });

  it('TITLE-02 does not overwrite an explicitly provided title', async () => {
    const room = 'TITLE2';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const hasTrack = waitFor<RoomState>(
      controller,
      S2C.State,
      (s) => s.currentTrack?.id === 'dQw4w9WgXcQ',
    );
    const ack = (await controller.emitWithAck(C2S.ChangeTrack, {
      url: VALID_URL,
      reason: 'set the vibe',
      title: 'My Title',
    })) as Ack;
    expect(ack.ok).toBe(true);

    const s = await hasTrack;
    expect(s.currentTrack?.title).toBe('My Title');
  });

  it('SEC-01 never leaks the room password into any broadcast state', async () => {
    const room = 'SEC01';
    const creator = connect();
    const createAck = (await creator.emitWithAck(C2S.Join, {
      roomCode: room,
      role: 'controller',
      password: 'secret',
    })) as Ack;
    expect(createAck.ok).toBe(true);

    // An observer joins with the correct password; capture every state it sees.
    const observer = connect();
    const seen: RoomState[] = [];
    observer.on(S2C.State, (s: RoomState) => {
      seen.push(s);
    });

    const joinAck = (await observer.emitWithAck(C2S.Join, {
      roomCode: room,
      role: 'player',
      password: 'secret',
    })) as Ack;
    expect(joinAck.ok).toBe(true);

    // Trigger another broadcast so we exercise more than just the join state.
    const sawTrack = waitFor<RoomState>(
      observer,
      S2C.State,
      (s) => s.currentTrack?.id === 'dQw4w9WgXcQ',
    );
    await creator.emitWithAck(C2S.ChangeTrack, { url: VALID_URL, reason: 'set the vibe' });
    await sawTrack;

    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(Object.keys(s)).not.toContain('password');
      expect(JSON.stringify(s)).not.toContain('secret');
    }
  });

  // ── GAIN-xx: per-track loudness normalization ───────────────────────────────

  it('GAIN-01 setTrackGain broadcasts trackGain[id] and logs a gain activity', async () => {
    const room = 'GAIN01';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const hasGain = (s: RoomState) => s.trackGain.dQw4w9WgXcQ === 0.5;
    const isGain = (a: ActivityEntry) => a.type === 'gain';
    const playerState = waitFor<RoomState>(player, S2C.State, hasGain);
    const playerActivity = waitFor<ActivityEntry>(player, S2C.Activity, isGain);

    const ack = (await controller.emitWithAck(C2S.SetTrackGain, {
      videoId: 'dQw4w9WgXcQ',
      gain: 0.5,
    })) as Ack;
    expect(ack.ok).toBe(true);

    const [ps, pa] = await Promise.all([playerState, playerActivity]);
    expect(ps.trackGain.dQw4w9WgXcQ).toBe(0.5);
    expect(pa.type).toBe('gain');
    expect((pa.detail as { gain: number }).gain).toBe(0.5);
  });

  it('GAIN-02 clamps setTrackGain to [0.2, 1.0]', async () => {
    const room = 'GAIN02';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const high = waitFor<RoomState>(controller, S2C.State, (s) => s.trackGain.aaaaaaaaaaa === 1.0);
    const highAck = (await controller.emitWithAck(C2S.SetTrackGain, {
      videoId: 'aaaaaaaaaaa',
      gain: 5,
    })) as Ack;
    expect(highAck.ok).toBe(true);
    expect((await high).trackGain.aaaaaaaaaaa).toBe(1.0);

    const low = waitFor<RoomState>(controller, S2C.State, (s) => s.trackGain.bbbbbbbbbbb === 0.2);
    const lowAck = (await controller.emitWithAck(C2S.SetTrackGain, {
      videoId: 'bbbbbbbbbbb',
      gain: 0,
    })) as Ack;
    expect(lowAck.ok).toBe(true);
    expect((await low).trackGain.bbbbbbbbbbb).toBe(0.2);
  });

  it('GAIN-03 auto-seeds trackGain from a loud YouTube loudnessDb on changeTrack', async () => {
    // Dedicated server: loudness stub reports +6 dB ⇒ factor ≈ 10^(-6/20) ≈ 0.5.
    const local = createServer(
      undefined,
      async () => 'T',
      async () => 6,
    );
    await new Promise<void>((resolve) => local.httpServer.listen(0, '127.0.0.1', () => resolve()));
    const localPort = (local.httpServer.address() as AddressInfo).port;
    const localClients: ClientSocket[] = [];
    const localConnect = () => {
      const s = ioClient(`http://127.0.0.1:${localPort}`, { forceNew: true });
      localClients.push(s);
      return s;
    };

    try {
      const controller = localConnect();
      await controller.emitWithAck(C2S.Join, { roomCode: 'GAIN03', role: 'controller' });

      const seeded = waitFor<RoomState>(controller, S2C.State, (s) => {
        const g = s.trackGain.dQw4w9WgXcQ;
        return g !== undefined && g < 1;
      });
      const ack = (await controller.emitWithAck(C2S.ChangeTrack, {
        url: VALID_URL,
        reason: 'auto seed',
      })) as Ack;
      expect(ack.ok).toBe(true);

      const s = await seeded;
      expect(s.trackGain.dQw4w9WgXcQ).toBeCloseTo(0.5, 2);
    } finally {
      for (const c of localClients) c.disconnect();
      local.io.close();
      await new Promise<void>((resolve) => local.httpServer.close(() => resolve()));
    }
  });

  // ── MODE / REPEAT / SHUFFLE: playback modes ─────────────────────────────────

  const SECOND_URL = 'https://youtu.be/9bZkp7q19f0';
  const SECOND_ID = '9bZkp7q19f0';
  const THIRD_URL = 'https://youtu.be/kJQP7kiw5Fk';

  it('MODE-01 setRepeat broadcasts state.repeat and logs a mode activity', async () => {
    const room = 'MODE01';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const repeatAll = (s: RoomState) => s.repeat === 'all';
    const isMode = (a: ActivityEntry) => a.type === 'mode';
    const playerState = waitFor<RoomState>(player, S2C.State, repeatAll);
    const playerActivity = waitFor<ActivityEntry>(player, S2C.Activity, isMode);

    const ack = (await controller.emitWithAck(C2S.SetRepeat, { mode: 'all' })) as Ack;
    expect(ack.ok).toBe(true);

    const [ps, pa] = await Promise.all([playerState, playerActivity]);
    expect(ps.repeat).toBe('all');
    expect(pa.type).toBe('mode');
    expect((pa.detail as { repeat: string }).repeat).toBe('all');
  });

  it('MODE-02 setShuffle broadcasts state.shuffle', async () => {
    const room = 'MODE02';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const shuffleOn = waitFor<RoomState>(controller, S2C.State, (s) => s.shuffle === true);
    const ack = (await controller.emitWithAck(C2S.SetShuffle, { shuffle: true })) as Ack;
    expect(ack.ok).toBe(true);

    const s = await shuffleOn;
    expect(s.shuffle).toBe(true);
  });

  it('REPEAT-ONE replays the current track on trackEnded (lastSeek 0, same track)', async () => {
    const room = 'REPONE';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    await controller.emitWithAck(C2S.SetRepeat, { mode: 'one' });
    const hasA = waitFor<RoomState>(player, S2C.State, (s) => s.currentTrack?.id === 'dQw4w9WgXcQ');
    await controller.emitWithAck(C2S.ChangeTrack, { url: VALID_URL, reason: 'A' });
    await hasA;

    const replayed = waitFor<RoomState>(
      player,
      S2C.State,
      (s) => s.lastSeek?.seconds === 0 && s.currentTrack?.id === 'dQw4w9WgXcQ' && s.isPlaying,
    );
    const ack = (await player.emitWithAck(C2S.TrackEnded, {})) as Ack;
    expect(ack.ok).toBe(true);

    const s = await replayed;
    expect(s.lastSeek?.seconds).toBe(0);
    expect(s.currentTrack?.id).toBe('dQw4w9WgXcQ');
    expect(s.isPlaying).toBe(true);
  });

  it('REPEAT-ALL loops back to an earlier track from history when the queue empties', async () => {
    const room = 'REPALL';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    await controller.emitWithAck(C2S.SetRepeat, { mode: 'all' });
    const hasA = waitFor<RoomState>(player, S2C.State, (s) => s.currentTrack?.id === 'dQw4w9WgXcQ');
    await controller.emitWithAck(C2S.ChangeTrack, { url: VALID_URL, reason: 'A' });
    await hasA;
    await controller.emitWithAck(C2S.EnqueueTrack, { url: SECOND_URL });

    // First trackEnded promotes B (queue head); A moves into history.
    const onB = waitFor<RoomState>(
      player,
      S2C.State,
      (s) => s.currentTrack?.id === SECOND_ID && s.queue.length === 0,
    );
    expect(((await player.emitWithAck(C2S.TrackEnded, {})) as Ack).ok).toBe(true);
    const sB = await onB;
    expect(sB.currentTrack?.id).toBe(SECOND_ID);

    // Second trackEnded: queue empty + repeat 'all' loops back to A from history.
    const loopedA = waitFor<RoomState>(
      player,
      S2C.State,
      (s) => s.currentTrack?.id === 'dQw4w9WgXcQ' && s.isPlaying,
    );
    expect(((await player.emitWithAck(C2S.TrackEnded, {})) as Ack).ok).toBe(true);
    const sA = await loopedA;
    expect(sA.currentTrack?.id).toBe('dQw4w9WgXcQ');
    expect(sA.isPlaying).toBe(true);
  });

  it('OFF-STOP stops playback when the queue empties under repeat off', async () => {
    const room = 'OFFSTP';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // repeat defaults to 'off'.
    const playing = waitFor<RoomState>(
      player,
      S2C.State,
      (s) => s.currentTrack?.id === 'dQw4w9WgXcQ' && s.isPlaying,
    );
    await controller.emitWithAck(C2S.ChangeTrack, { url: VALID_URL, reason: 'A' });
    await playing;

    const stopped = waitFor<RoomState>(
      player,
      S2C.State,
      (s) => s.isPlaying === false && s.currentTrack?.id === 'dQw4w9WgXcQ',
    );
    const ack = (await player.emitWithAck(C2S.TrackEnded, {})) as Ack;
    expect(ack.ok).toBe(true);

    const s = await stopped;
    expect(s.isPlaying).toBe(false);
    expect(s.currentTrack?.id).toBe('dQw4w9WgXcQ');
  });

  it('SHUFFLE picks a random queued track on manual nextTrack', async () => {
    const room = 'SHUF01';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    await controller.emitWithAck(C2S.SetShuffle, { shuffle: true });
    await controller.emitWithAck(C2S.EnqueueTrack, { url: SECOND_URL });
    await controller.emitWithAck(C2S.EnqueueTrack, { url: THIRD_URL });

    const advanced = waitFor<RoomState>(
      controller,
      S2C.State,
      (s) => s.currentTrack?.id === SECOND_ID || s.currentTrack?.id === 'kJQP7kiw5Fk',
    );
    const ack = (await controller.emitWithAck(C2S.NextTrack, {})) as Ack;
    expect(ack.ok).toBe(true);

    const s = await advanced;
    expect(['9bZkp7q19f0', 'kJQP7kiw5Fk']).toContain(s.currentTrack?.id);
    expect(s.queue.length).toBe(1);
  });

  it('GAIN-04 auto-seed never overwrites a manually set gain', async () => {
    // Loudness stub reports +6 dB (would auto-seed ≈0.5), but a manual 0.8 wins.
    const local = createServer(
      undefined,
      async () => 'T',
      async () => 6,
    );
    await new Promise<void>((resolve) => local.httpServer.listen(0, '127.0.0.1', () => resolve()));
    const localPort = (local.httpServer.address() as AddressInfo).port;
    const localClients: ClientSocket[] = [];
    const localConnect = () => {
      const s = ioClient(`http://127.0.0.1:${localPort}`, { forceNew: true });
      localClients.push(s);
      return s;
    };

    try {
      const controller = localConnect();
      await controller.emitWithAck(C2S.Join, { roomCode: 'GAIN04', role: 'controller' });

      const manual = waitFor<RoomState>(
        controller,
        S2C.State,
        (s) => s.trackGain.dQw4w9WgXcQ === 0.8,
      );
      await controller.emitWithAck(C2S.SetTrackGain, { videoId: 'dQw4w9WgXcQ', gain: 0.8 });
      await manual;

      const advanced = waitFor<RoomState>(
        controller,
        S2C.State,
        (s) => s.currentTrack?.id === 'dQw4w9WgXcQ',
      );
      const ack = (await controller.emitWithAck(C2S.ChangeTrack, {
        url: VALID_URL,
        reason: 'manual wins',
      })) as Ack;
      expect(ack.ok).toBe(true);
      const changed = await advanced;
      // The changeTrack broadcast still carries the manual gain (auto-seed skips
      // an already-set videoId).
      expect(changed.trackGain.dQw4w9WgXcQ).toBe(0.8);

      // Let the fire-and-forget auto-seed run, then probe a fresh broadcast
      // (setVolume always broadcasts) and confirm the manual gain is untouched.
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      const probe = waitFor<RoomState>(controller, S2C.State, (s) => s.volume === 33);
      await controller.emitWithAck(C2S.SetVolume, { volume: 33 });
      const latest = await probe;
      expect(latest.trackGain.dQw4w9WgXcQ).toBe(0.8);
    } finally {
      for (const c of localClients) c.disconnect();
      local.io.close();
      await new Promise<void>((resolve) => local.httpServer.close(() => resolve()));
    }
  });

  // ── SCHED-xx: weekly play schedule (예약 재생/종료) ──────────────────────────
  // 2026-06-01 is a Monday. Fixed instants keep the time-based logic
  // deterministic (the scheduler is driven via the injected `tick(now)`).
  const MON_10 = new Date(2026, 5, 1, 10, 0, 0); // Mon 10:00 (inside 09–18)
  const MON_20 = new Date(2026, 5, 1, 20, 0, 0); // Mon 20:00 (outside 09–18)

  type DK = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
  // Mon ON 09:00–18:00, every other day OFF.
  function monSchedule() {
    const off = { on: false, start: '00:00', end: '23:59' };
    const days = {} as Record<DK, { on: boolean; start: string; end: string }>;
    for (const d of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as DK[]) {
      days[d] = { ...off };
    }
    days.mon = { on: true, start: '09:00', end: '18:00' };
    return { enabled: true, days };
  }

  it('SCHED-01 setSchedule broadcasts state.schedule + logs a schedule activity', async () => {
    const room = 'SCHED1';
    const controller = connect();
    const observer = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await observer.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const enabled = (s: RoomState) => s.schedule?.enabled === true;
    const isSchedule = (a: ActivityEntry) => a.type === 'schedule';
    const obsState = waitFor<RoomState>(observer, S2C.State, enabled);
    const obsActivity = waitFor<ActivityEntry>(observer, S2C.Activity, isSchedule);

    const ack = (await controller.emitWithAck(C2S.SetSchedule, {
      schedule: monSchedule(),
    })) as Ack;
    expect(ack.ok).toBe(true);

    const [os, oa] = await Promise.all([obsState, obsActivity]);
    expect(os.schedule?.enabled).toBe(true);
    expect(oa.type).toBe('schedule');
  });

  it('SCHED-02 rejects a schedule with start>end or bad HH:MM', async () => {
    const room = 'SCHED2';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const badRange = monSchedule();
    badRange.days.mon = { on: true, start: '18:00', end: '09:00' };
    const rangeAck = (await controller.emitWithAck(C2S.SetSchedule, {
      schedule: badRange,
    })) as Ack;
    expect(rangeAck.ok).toBe(false);
    expect(rangeAck.error).toBe('invalid schedule');

    const badTime = monSchedule();
    badTime.days.mon = { on: true, start: '09:00', end: '25:99' };
    const timeAck = (await controller.emitWithAck(C2S.SetSchedule, {
      schedule: badTime,
    })) as Ack;
    expect(timeAck.ok).toBe(false);
    expect(timeAck.error).toBe('invalid schedule');
  });

  it('SCHED-03 auto-starts playback on the schedule edge inside the window', async () => {
    const room = 'SCHED3';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    await controller.emitWithAck(C2S.SetSchedule, { schedule: monSchedule() });
    const hasTrack = waitFor<RoomState>(
      controller,
      S2C.State,
      (s) => s.currentTrack?.id === 'dQw4w9WgXcQ',
    );
    await controller.emitWithAck(C2S.ChangeTrack, { url: VALID_URL, reason: 'A' });
    await hasTrack;
    // Manually pause so the scheduler edge has something to turn back on.
    await controller.emitWithAck(C2S.TogglePlay, { isPlaying: false });

    const playing = waitFor<RoomState>(controller, S2C.State, (s) => s.isPlaying === true);
    await tick(MON_10); // edge: no-opinion/false → true ⇒ start
    const s = await playing;
    expect(s.isPlaying).toBe(true);
  });

  it('SCHED-04 auto-stops playback on the schedule edge outside the window', async () => {
    const room = 'SCHED4';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    await controller.emitWithAck(C2S.SetSchedule, { schedule: monSchedule() });
    const playing = waitFor<RoomState>(controller, S2C.State, (s) => s.isPlaying === true);
    await controller.emitWithAck(C2S.ChangeTrack, { url: VALID_URL, reason: 'A' });
    await playing;

    const stopped = waitFor<RoomState>(controller, S2C.State, (s) => s.isPlaying === false);
    await tick(MON_20); // edge: → false ⇒ stop
    const s = await stopped;
    expect(s.isPlaying).toBe(false);
  });

  it('SCHED-05 does not fight a manual pause mid-window (edge-triggered)', async () => {
    const room = 'SCHED5';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    await controller.emitWithAck(C2S.SetSchedule, { schedule: monSchedule() });
    const hasTrack = waitFor<RoomState>(
      controller,
      S2C.State,
      (s) => s.currentTrack?.id === 'dQw4w9WgXcQ',
    );
    await controller.emitWithAck(C2S.ChangeTrack, { url: VALID_URL, reason: 'A' });
    await hasTrack;
    // Pause so the first tick has a real edge (false → true ⇒ play).
    const prePaused = waitFor<RoomState>(controller, S2C.State, (s) => s.isPlaying === false);
    await controller.emitWithAck(C2S.TogglePlay, { isPlaying: false });
    await prePaused;

    // First tick is the edge → playing.
    const playing = waitFor<RoomState>(controller, S2C.State, (s) => s.isPlaying === true);
    await tick(MON_10);
    await playing;

    // Manual pause mid-window.
    const paused = waitFor<RoomState>(controller, S2C.State, (s) => s.isPlaying === false);
    await controller.emitWithAck(C2S.TogglePlay, { isPlaying: false });
    await paused;

    // Still inside the window, but no edge (want stays true) → must NOT resume.
    await tick(new Date(2026, 5, 1, 10, 1, 0));

    // Probe a fresh broadcast (setVolume always broadcasts) and confirm the
    // manual pause survived — the scheduler did not flip isPlaying back on.
    const probe = waitFor<RoomState>(controller, S2C.State, (s) => s.volume === 33);
    await controller.emitWithAck(C2S.SetVolume, { volume: 33 });
    const latest = await probe;
    expect(latest.isPlaying).toBe(false);
  });
});
