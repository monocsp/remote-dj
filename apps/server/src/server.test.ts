import type { AddressInfo } from 'node:net';
import { type Ack, type ActivityEntry, C2S, LIMITS, type RoomState, S2C } from '@remote-dj/shared';
import { type Socket as ClientSocket, io as ioClient } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, decideEmbed } from './index.js';

const VALID_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const VALID_ID = 'dQw4w9WgXcQ';

// ── decideEmbed: add-time block / unblock decision ──────────────────────────
describe('decideEmbed', () => {
  it('rejects when authoritatively not embeddable (false)', () => {
    expect(decideEmbed(false, [], 'x')).toEqual({ reject: true, blockedIds: [] });
  });
  it('rejects an already-blocked id for an unknown (null) result', () => {
    expect(decideEmbed(null, ['x'], 'x')).toEqual({ reject: true, blockedIds: ['x'] });
  });
  it('keeps a learned 150 block STICKY even when the Data API says embeddable (true)', () => {
    // licensed-music videos report embeddable=true yet still fail with 150, so a
    // learned playback block must NOT be auto-cleared by a `true` result.
    expect(decideEmbed(true, ['x', 'y'], 'x')).toEqual({ reject: true, blockedIds: ['x', 'y'] });
  });
  it('allows a non-blocked id (true or null), blocklist unchanged', () => {
    expect(decideEmbed(null, ['y'], 'x')).toEqual({ reject: false, blockedIds: ['y'] });
    expect(decideEmbed(true, ['y'], 'x')).toEqual({ reject: false, blockedIds: ['y'] });
  });
});

// ── Playlist/cursor helpers ────────────────────────────────────────────────
// The server now keeps a single `playlist` + `currentIndex` cursor (the old
// currentTrack/queue/history model was removed). These derive the equivalent
// views so assertions read like the old ones.

/** The current track (playlist[currentIndex]) or null when idle/empty. */
function currentTrack(s: RoomState) {
  return s.currentIndex >= 0 ? (s.playlist[s.currentIndex] ?? null) : null;
}

/** The current track id or undefined. */
function currentId(s: RoomState): string | undefined {
  return currentTrack(s)?.id;
}

/** Upcoming (not-yet-played) items: those AFTER the cursor. */
function upcoming(s: RoomState) {
  return s.currentIndex >= 0 ? s.playlist.slice(s.currentIndex + 1) : s.playlist;
}

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
      async () => true,
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

    const hasTrack = (s: RoomState) => currentId(s) === VALID_ID;
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

    expect(currentId(os)).toBe(VALID_ID);
    expect(currentId(ps)).toBe(VALID_ID);
    // changeTrack appends the new track and jumps the cursor onto it, playing.
    expect(ps.isPlaying).toBe(true);
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

  it('allows guest control events from a player (changeTrack/setVolume/togglePlay)', async () => {
    const room = 'ROOM04';
    const player = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const changeAck = (await player.emitWithAck(C2S.ChangeTrack, {
      url: VALID_URL,
      reason: 'i want this',
    })) as Ack;
    expect(changeAck.ok).toBe(true);

    const volAck = (await player.emitWithAck(C2S.SetVolume, { volume: 40 })) as Ack;
    expect(volAck.ok).toBe(true);

    const toggleAck = (await player.emitWithAck(C2S.TogglePlay, { isPlaying: false })) as Ack;
    expect(toggleAck.ok).toBe(true);
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
      if (currentId(s) === VALID_ID) moverSawTrack = true;
    });

    // stayer changes track in ROOM_A and should see it; mover must not.
    const stayerState = waitFor<RoomState>(stayer, S2C.State, (s) => currentId(s) === VALID_ID);
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
    const player = connect();
    await observer.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const obsState = waitFor<RoomState>(observer, S2C.State, (s) => s.lastSeek?.seconds === 37);
    // seekTo is a MAIN action: player-only.
    const ack = (await player.emitWithAck(C2S.SeekTo, { seconds: 37 })) as Ack;
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

  it('QUEUE-14 enqueue into an IDLE room auto-starts that track', async () => {
    const room = 'QUEUE14';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // Fresh idle room (currentIndex < 0): the first enqueue sets currentIndex=0
    // and starts playing it, with no upcoming items behind it.
    const started = (s: RoomState) =>
      currentId(s) === VALID_ID && s.isPlaying && upcoming(s).length === 0;
    const isEnqueue = (a: ActivityEntry) => a.type === 'enqueue';
    const playerState = waitFor<RoomState>(player, S2C.State, started);
    const playerActivity = waitFor<ActivityEntry>(player, S2C.Activity, isEnqueue);

    const ack = (await controller.emitWithAck(C2S.EnqueueTrack, {
      url: VALID_URL,
      title: 'Never Gonna Give You Up',
    })) as Ack;
    expect(ack.ok).toBe(true);

    const [ps, pa] = await Promise.all([playerState, playerActivity]);
    expect(currentId(ps)).toBe(VALID_ID);
    expect(ps.currentIndex).toBe(0);
    expect(ps.isPlaying).toBe(true);
    expect(upcoming(ps).length).toBe(0);
    expect(pa.type).toBe('enqueue');
  });

  it('enqueue while a track is playing appends to the playlist (upcoming) and logs enqueue', async () => {
    const room = 'QUEUE1';
    const SECOND_URL = 'https://youtu.be/9bZkp7q19f0';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // Establish a playing current track first (A) so the next enqueue (B) is
    // appended behind it rather than auto-starting.
    const hasA = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
    await controller.emitWithAck(C2S.ChangeTrack, { url: VALID_URL, reason: 'A' });
    await hasA;

    const hasQueued = (s: RoomState) => upcoming(s).some((t) => t.id === '9bZkp7q19f0');
    const isEnqueue = (a: ActivityEntry) => a.type === 'enqueue';
    const playerState = waitFor<RoomState>(player, S2C.State, hasQueued);
    const playerActivity = waitFor<ActivityEntry>(player, S2C.Activity, isEnqueue);

    const ack = (await controller.emitWithAck(C2S.EnqueueTrack, {
      url: SECOND_URL,
      title: 'Gangnam Style',
    })) as Ack;
    expect(ack.ok).toBe(true);

    const [ps, pa] = await Promise.all([playerState, playerActivity]);
    expect(upcoming(ps)[0]?.id).toBe('9bZkp7q19f0');
    // The current track (A) is unchanged: enqueue appends, it does not jump.
    expect(currentId(ps)).toBe(VALID_ID);
    expect(pa.type).toBe('enqueue');
  });

  it('nextTrack (player) advances the cursor to the upcoming item', async () => {
    const room = 'QUEUE2';
    const SECOND_URL = 'https://youtu.be/9bZkp7q19f0';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // A becomes current (auto-start); B then appends behind it. Register each
    // predicate wait BEFORE its triggering emit so a fast broadcast isn't missed.
    const onA = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
    await controller.emitWithAck(C2S.EnqueueTrack, { url: VALID_URL });
    await onA;
    const queued = waitFor<RoomState>(player, S2C.State, (s) =>
      upcoming(s).some((t) => t.id === '9bZkp7q19f0'),
    );
    await controller.emitWithAck(C2S.EnqueueTrack, { url: SECOND_URL });
    await queued;

    const advanced = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === '9bZkp7q19f0');
    // nextTrack is a MAIN action: player-only.
    const ack = (await player.emitWithAck(C2S.NextTrack, {})) as Ack;
    expect(ack.ok).toBe(true);

    const state = await advanced;
    expect(currentId(state)).toBe('9bZkp7q19f0');
    expect(state.currentIndex).toBe(1);
    expect(upcoming(state).length).toBe(0);
    expect(state.isPlaying).toBe(true);
  });

  it('nextTrack from a controller is rejected (player only)', async () => {
    const room = 'QUEUE2C';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const ack = (await controller.emitWithAck(C2S.NextTrack, {})) as Ack;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('player only');
  });

  it('nextTrack at the end of the playlist is a no-op ok (player)', async () => {
    const room = 'QUEUE3';
    const player = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const ack = (await player.emitWithAck(C2S.NextTrack, {})) as Ack;
    expect(ack.ok).toBe(true);
  });

  // ── JUMP-xx: jumpTo cursor jump (player-only) ───────────────────────────────

  it('JUMP-01 jumpTo (player) moves the cursor to an existing index and plays it', async () => {
    const room = 'JUMP01';
    const SECOND_URL = 'https://youtu.be/9bZkp7q19f0';
    const player = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // Build a 2-item playlist: A (index 0, current) + B (index 1, upcoming).
    const hasA = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
    await player.emitWithAck(C2S.EnqueueTrack, { url: VALID_URL });
    await hasA;
    const built = waitFor<RoomState>(
      player,
      S2C.State,
      (s) => s.playlist.length === 2 && s.playlist[1]?.id === '9bZkp7q19f0',
    );
    await player.emitWithAck(C2S.EnqueueTrack, { url: SECOND_URL });
    await built;

    // Jump to index 1 (B). currentIndex must move forward and playback resume.
    const jumped = waitFor<RoomState>(
      player,
      S2C.State,
      (s) => s.currentIndex === 1 && currentId(s) === '9bZkp7q19f0',
    );
    const isTrackChange = (a: ActivityEntry) => a.type === 'track_change';
    const activity = waitFor<ActivityEntry>(player, S2C.Activity, isTrackChange);
    const ack = (await player.emitWithAck(C2S.JumpTo, { index: 1 })) as Ack;
    expect(ack.ok).toBe(true);

    const [s, a] = await Promise.all([jumped, activity]);
    expect(s.currentIndex).toBe(1);
    expect(currentId(s)).toBe('9bZkp7q19f0');
    expect(s.isPlaying).toBe(true);
    expect(s.playbackError).toBeNull();
    expect(a.type).toBe('track_change');
    expect((a.detail as { id: string }).id).toBe('9bZkp7q19f0');
  });

  it('JUMP-02 rejects jumpTo from a controller (player only)', async () => {
    const room = 'JUMP02';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // Give the room a track so an index 0 would otherwise be valid.
    const hasA = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
    await player.emitWithAck(C2S.EnqueueTrack, { url: VALID_URL });
    await hasA;

    const ack = (await controller.emitWithAck(C2S.JumpTo, { index: 0 })) as Ack;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('player only');
  });

  it('JUMP-03 rejects jumpTo with an out-of-range index (player)', async () => {
    const room = 'JUMP03';
    const player = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // Empty playlist → any index is out of range.
    const emptyAck = (await player.emitWithAck(C2S.JumpTo, { index: 0 })) as Ack;
    expect(emptyAck.ok).toBe(false);
    expect(emptyAck.error).toBe('invalid index');

    // One-item playlist: index 5 is out of range.
    const hasA = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
    await player.emitWithAck(C2S.EnqueueTrack, { url: VALID_URL });
    await hasA;

    const ack = (await player.emitWithAck(C2S.JumpTo, { index: 5 })) as Ack;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('invalid index');
  });

  it('removeQueued with an out-of-range index acks false (invalid index) for both roles', async () => {
    const room = 'QUEUE4';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // removeQueued is a member action (controller OR player); the range check
    // runs before ownership, so an out-of-range index is 'invalid index'.
    const rejected = (await controller.emitWithAck(C2S.RemoveQueued, { index: 5 })) as Ack;
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toBe('invalid index');

    const ack = (await player.emitWithAck(C2S.RemoveQueued, { index: 5 })) as Ack;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('invalid index');
  });

  it('REMOVE-OWN a controller may remove a playlist item it added (ownership)', async () => {
    const room = 'RMOWN';
    const SECOND_URL = 'https://youtu.be/9bZkp7q19f0';
    const controllerA = connect();
    const player = connect();
    await controllerA.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // Establish a playing current track so the next enqueue appends (index 1).
    const hasA = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
    await controllerA.emitWithAck(C2S.ChangeTrack, { url: VALID_URL, reason: 'A' });
    await hasA;

    const queued = waitFor<RoomState>(player, S2C.State, (s) =>
      upcoming(s).some((t) => t.id === '9bZkp7q19f0'),
    );
    await controllerA.emitWithAck(C2S.EnqueueTrack, { url: SECOND_URL });
    const qs = await queued;
    // The enqueued item is owned by controllerA's socket.
    expect(upcoming(qs)[0]?.ownerId).toBe(controllerA.id);

    // Remove the upcoming item at index 1 (after the current cursor).
    const removed = waitFor<RoomState>(player, S2C.State, (s) => s.playlist.length === 1);
    const ack = (await controllerA.emitWithAck(C2S.RemoveQueued, { index: 1 })) as Ack;
    expect(ack.ok).toBe(true);
    const rs = await removed;
    expect(rs.playlist.length).toBe(1);
    expect(upcoming(rs).length).toBe(0);
  });

  it('REMOVE-OTHER a different controller cannot remove an item it did not add', async () => {
    const room = 'RMOTHER';
    const SECOND_URL = 'https://youtu.be/9bZkp7q19f0';
    const controllerA = connect();
    const controllerB = connect();
    const player = connect();
    await controllerA.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await controllerB.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const hasA = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
    await controllerA.emitWithAck(C2S.ChangeTrack, { url: VALID_URL, reason: 'A' });
    await hasA;

    const queued = waitFor<RoomState>(player, S2C.State, (s) =>
      upcoming(s).some((t) => t.id === '9bZkp7q19f0'),
    );
    await controllerA.emitWithAck(C2S.EnqueueTrack, { url: SECOND_URL });
    await queued;

    // controllerB did not add the item at index 1 → rejected.
    const ack = (await controllerB.emitWithAck(C2S.RemoveQueued, { index: 1 })) as Ack;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('not your item');
  });

  it('REMOVE-PLAYER a player may remove any playlist item (added by a controller)', async () => {
    const room = 'RMPLAYER';
    const SECOND_URL = 'https://youtu.be/9bZkp7q19f0';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const hasA = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
    await controller.emitWithAck(C2S.ChangeTrack, { url: VALID_URL, reason: 'A' });
    await hasA;

    const queued = waitFor<RoomState>(player, S2C.State, (s) =>
      upcoming(s).some((t) => t.id === '9bZkp7q19f0'),
    );
    await controller.emitWithAck(C2S.EnqueueTrack, { url: SECOND_URL });
    await queued;

    // The player (main) may remove any item, even one added by a controller.
    const removed = waitFor<RoomState>(player, S2C.State, (s) => s.playlist.length === 1);
    const ack = (await player.emitWithAck(C2S.RemoveQueued, { index: 1 })) as Ack;
    expect(ack.ok).toBe(true);
    expect((await removed).playlist.length).toBe(1);
  });

  // ── REMCUR-xx: removeQueued cursor adjustment ───────────────────────────────

  it('REMCUR-01 removing an item BEFORE the cursor shifts currentIndex left (same track stays current)', async () => {
    const room = 'REMCUR1';
    const SECOND_URL = 'https://youtu.be/9bZkp7q19f0';
    const player = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // Build [A, B], then jump the cursor to B (index 1).
    const hasA = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
    await player.emitWithAck(C2S.EnqueueTrack, { url: VALID_URL });
    await hasA;
    const built = waitFor<RoomState>(player, S2C.State, (s) => s.playlist.length === 2);
    await player.emitWithAck(C2S.EnqueueTrack, { url: SECOND_URL });
    await built;
    const onB = waitFor<RoomState>(player, S2C.State, (s) => s.currentIndex === 1);
    await player.emitWithAck(C2S.JumpTo, { index: 1 });
    await onB;

    // Remove A (index 0, BEFORE the cursor): cursor shifts to 0, B stays current.
    const removed = waitFor<RoomState>(player, S2C.State, (s) => s.playlist.length === 1);
    const ack = (await player.emitWithAck(C2S.RemoveQueued, { index: 0 })) as Ack;
    expect(ack.ok).toBe(true);

    const s = await removed;
    expect(s.currentIndex).toBe(0);
    expect(currentId(s)).toBe('9bZkp7q19f0');
  });

  it('REMCUR-02 removing the CURRENT item slides the next track into the cursor', async () => {
    const room = 'REMCUR2';
    const SECOND_URL = 'https://youtu.be/9bZkp7q19f0';
    const player = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // Build [A(current, idx0), B(idx1)].
    const hasA = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
    await player.emitWithAck(C2S.EnqueueTrack, { url: VALID_URL });
    await hasA;
    const built = waitFor<RoomState>(player, S2C.State, (s) => s.playlist.length === 2);
    await player.emitWithAck(C2S.EnqueueTrack, { url: SECOND_URL });
    await built;

    // Remove the current item (index 0): B slides into index 0 and is current.
    const removed = waitFor<RoomState>(player, S2C.State, (s) => s.playlist.length === 1);
    const ack = (await player.emitWithAck(C2S.RemoveQueued, { index: 0 })) as Ack;
    expect(ack.ok).toBe(true);

    const s = await removed;
    expect(s.currentIndex).toBe(0);
    expect(currentId(s)).toBe('9bZkp7q19f0');
    expect(s.playbackError).toBeNull();
  });

  it('REMCUR-03 removing the only (current) item empties the playlist and stops', async () => {
    const room = 'REMCUR3';
    const player = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const hasA = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
    await player.emitWithAck(C2S.EnqueueTrack, { url: VALID_URL });
    await hasA;

    const removed = waitFor<RoomState>(player, S2C.State, (s) => s.playlist.length === 0);
    const ack = (await player.emitWithAck(C2S.RemoveQueued, { index: 0 })) as Ack;
    expect(ack.ok).toBe(true);

    const s = await removed;
    expect(s.playlist.length).toBe(0);
    expect(s.currentIndex).toBe(-1);
    expect(s.isPlaying).toBe(false);
  });

  it('REMCUR-04 removing an item AFTER the cursor leaves currentIndex unchanged', async () => {
    const room = 'REMCUR4';
    const SECOND_URL = 'https://youtu.be/9bZkp7q19f0';
    const player = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // Build [A(current, idx0), B(idx1)].
    const hasA = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
    await player.emitWithAck(C2S.EnqueueTrack, { url: VALID_URL });
    await hasA;
    const built = waitFor<RoomState>(player, S2C.State, (s) => s.playlist.length === 2);
    await player.emitWithAck(C2S.EnqueueTrack, { url: SECOND_URL });
    await built;

    // Remove the upcoming item B (index 1, AFTER the cursor): cursor unchanged.
    const removed = waitFor<RoomState>(player, S2C.State, (s) => s.playlist.length === 1);
    const ack = (await player.emitWithAck(C2S.RemoveQueued, { index: 1 })) as Ack;
    expect(ack.ok).toBe(true);

    const s = await removed;
    expect(s.currentIndex).toBe(0);
    expect(currentId(s)).toBe(VALID_ID);
  });

  it('trackEnded from a player advances the cursor', async () => {
    const room = 'QUEUE5';
    const SECOND_URL = 'https://youtu.be/9bZkp7q19f0';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // A becomes current (auto-start); B appends behind it. Register each
    // predicate wait BEFORE its triggering emit so a fast broadcast isn't missed.
    const onA = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
    await controller.emitWithAck(C2S.EnqueueTrack, { url: VALID_URL });
    await onA;
    const queued = waitFor<RoomState>(player, S2C.State, (s) =>
      upcoming(s).some((t) => t.id === '9bZkp7q19f0'),
    );
    await controller.emitWithAck(C2S.EnqueueTrack, { url: SECOND_URL });
    await queued;

    const advanced = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === '9bZkp7q19f0');
    const ack = (await player.emitWithAck(C2S.TrackEnded, {})) as Ack;
    expect(ack.ok).toBe(true);

    const state = await advanced;
    expect(currentId(state)).toBe('9bZkp7q19f0');
    expect(upcoming(state).length).toBe(0);
  });

  it('allows enqueue + nextTrack from a player (guest event + main event)', async () => {
    const room = 'QUEUE6';
    const player = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const enqAck = (await player.emitWithAck(C2S.EnqueueTrack, { url: VALID_URL })) as Ack;
    expect(enqAck.ok).toBe(true);

    // nextTrack is also allowed for the Player (main action).
    const nextAck = (await player.emitWithAck(C2S.NextTrack, {})) as Ack;
    expect(nextAck.ok).toBe(true);
  });

  it('allows enqueue from a controller (guest event)', async () => {
    const room = 'QUEUE6C';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const enqAck = (await controller.emitWithAck(C2S.EnqueueTrack, { url: VALID_URL })) as Ack;
    expect(enqAck.ok).toBe(true);
  });

  it('rejects trackEnded from a controller (player-only)', async () => {
    const room = 'QUEUE7';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const ack = (await controller.emitWithAck(C2S.TrackEnded, {})) as Ack;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('player only');
  });

  it('seekTo by a player broadcasts lastSeek and logs a seek activity', async () => {
    const room = 'SEEK1';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const hasSeek = (s: RoomState) => s.lastSeek?.seconds === 42;
    const isSeek = (a: ActivityEntry) => a.type === 'seek';
    const controllerState = waitFor<RoomState>(controller, S2C.State, hasSeek);
    const controllerActivity = waitFor<ActivityEntry>(controller, S2C.Activity, isSeek);

    // seekTo is a MAIN action: player-only.
    const ack = (await player.emitWithAck(C2S.SeekTo, { seconds: 42 })) as Ack;
    expect(ack.ok).toBe(true);

    const [cs, ca] = await Promise.all([controllerState, controllerActivity]);
    expect(cs.lastSeek?.seconds).toBe(42);
    expect(ca.type).toBe('seek');
    expect((ca.detail as { seconds: number }).seconds).toBe(42);
  });

  it('rejects seekTo with negative seconds (player)', async () => {
    const room = 'SEEK2';
    const player = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const ack = (await player.emitWithAck(C2S.SeekTo, { seconds: -5 })) as Ack;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('invalid seconds');
  });

  it('rejects seekTo from a controller (player only)', async () => {
    const room = 'SEEK3';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const ack = (await controller.emitWithAck(C2S.SeekTo, { seconds: 10 })) as Ack;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('player only');
  });

  it('progress from a player updates state.progress and logs no activity', async () => {
    const room = 'SEEK4';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // Set a current track first so progress can be stamped with its id.
    const hasTrack = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
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
    // The server stamps the progress with the current track's id (playlist[currentIndex]).
    expect(cs.progress?.id).toBe(VALID_ID);
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

  it('SET-01 updateSettings (player) broadcasts new settings + logs a settings activity', async () => {
    const room = 'SET01';
    const player = connect();
    const observer = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });
    await observer.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const settingsOff = (s: RoomState) => s.settings.allowAnonymous === false;
    const isSettings = (a: ActivityEntry) => a.type === 'settings';
    const obsState = waitFor<RoomState>(observer, S2C.State, settingsOff);
    const obsActivity = waitFor<ActivityEntry>(observer, S2C.Activity, isSettings);

    // updateSettings is a MAIN action: player-only.
    const ack = (await player.emitWithAck(C2S.UpdateSettings, {
      settings: { allowAnonymous: false },
    })) as Ack;
    expect(ack.ok).toBe(true);

    const [os, oa] = await Promise.all([obsState, obsActivity]);
    expect(os.settings.allowAnonymous).toBe(false);
    expect(oa.type).toBe('settings');
  });

  it('SET-01b rejects updateSettings from a controller (player only)', async () => {
    const room = 'SET01B';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const ack = (await controller.emitWithAck(C2S.UpdateSettings, {
      settings: { allowAnonymous: false },
    })) as Ack;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('player only');
  });

  it('SET-02 rejects an anonymous controller changeTrack when allowAnonymous=false', async () => {
    const room = 'SET02';
    const player = connect(); // player flips the setting (updateSettings is main-only)
    const controller = connect(); // joins WITHOUT a nickname → anonymous
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const settingsAck = (await player.emitWithAck(C2S.UpdateSettings, {
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

  it('SET-02b an anonymous PLAYER changeTrack is NOT gated when allowAnonymous=false (player never gated)', async () => {
    const room = 'SET02P';
    const player = connect(); // anonymous player
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const settingsAck = (await player.emitWithAck(C2S.UpdateSettings, {
      settings: { allowAnonymous: false },
    })) as Ack;
    expect(settingsAck.ok).toBe(true);

    const ack = (await player.emitWithAck(C2S.ChangeTrack, {
      url: VALID_URL,
      reason: 'main is never gated',
    })) as Ack;
    expect(ack.ok).toBe(true);
  });

  it('SET-03 allows a controller WITH a nickname to changeTrack when allowAnonymous=false', async () => {
    const room = 'SET03';
    const player = connect();
    const named = connect();
    // A player flips the setting; a named controller can still change tracks.
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });
    await named.emitWithAck(C2S.Join, { roomCode: room, role: 'controller', nickname: 'dj' });

    const settingsAck = (await player.emitWithAck(C2S.UpdateSettings, {
      settings: { allowAnonymous: false },
    })) as Ack;
    expect(settingsAck.ok).toBe(true);

    const hasTrack = (s: RoomState) => currentId(s) === VALID_ID;
    const namedState = waitFor<RoomState>(named, S2C.State, hasTrack);

    const ack = (await named.emitWithAck(C2S.ChangeTrack, {
      url: VALID_URL,
      reason: 'i have a nickname',
    })) as Ack;
    expect(ack.ok).toBe(true);

    const s = await namedState;
    expect(currentId(s)).toBe(VALID_ID);
  });

  it('SET-04 setVolume from an anonymous controller still works when allowAnonymous=false (not gated)', async () => {
    const room = 'SET04';
    const player = connect();
    const controller = connect(); // anonymous
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const settingsAck = (await player.emitWithAck(C2S.UpdateSettings, {
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

  it('EMB-01 rejects a non-embeddable changeTrack/enqueue at add time', async () => {
    // Dedicated server whose embeddability resolver reports false (embed disabled).
    const local = createServer(
      undefined,
      async () => 'T',
      async () => null,
      async () => false,
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
      await controller.emitWithAck(C2S.Join, { roomCode: 'EMB01', role: 'controller' });

      const changeAck = (await controller.emitWithAck(C2S.ChangeTrack, {
        url: VALID_URL,
        reason: 'try a blocked video',
      })) as Ack;
      expect(changeAck.ok).toBe(false);
      expect(changeAck.error).toBe('embed disabled');

      const enqAck = (await controller.emitWithAck(C2S.EnqueueTrack, {
        url: VALID_URL,
      })) as Ack;
      expect(enqAck.ok).toBe(false);
      expect(enqAck.error).toBe('embed disabled');
    } finally {
      for (const c of localClients) c.disconnect();
      local.io.close();
      await new Promise<void>((resolve) => local.httpServer.close(() => resolve()));
    }
  });

  it('ERR-01 a player playbackError auto-skips to the next track and logs an error', async () => {
    const room = 'ERR01';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // A becomes current; B appends behind it → upcoming = [B].
    const onA = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
    await controller.emitWithAck(C2S.ChangeTrack, { url: VALID_URL, reason: 'A' });
    await onA;
    const queued = waitFor<RoomState>(player, S2C.State, (s) =>
      upcoming(s).some((t) => t.id === '9bZkp7q19f0'),
    );
    await controller.emitWithAck(C2S.EnqueueTrack, { url: 'https://youtu.be/9bZkp7q19f0' });
    await queued;

    // The bad current track errors → server auto-skips to B and logs an 'error'.
    const skipped = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === '9bZkp7q19f0');
    const errorLogged = waitFor<ActivityEntry>(
      controller,
      S2C.Activity,
      (a) => a.type === 'error' && (a.detail as { code?: number }).code === 150,
    );
    const ack = (await player.emitWithAck(C2S.PlaybackError, { code: 150 })) as Ack;
    expect(ack.ok).toBe(true);

    const [s, a] = await Promise.all([skipped, errorLogged]);
    expect(currentId(s)).toBe('9bZkp7q19f0');
    expect(a.type).toBe('error');
    expect((a.detail as { code: number }).code).toBe(150);
  });

  it('ERR-02 a player playbackError at the end of the playlist stops and keeps the error', async () => {
    const room = 'ERR02';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // A becomes current with nothing upcoming.
    const onA = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
    await controller.emitWithAck(C2S.ChangeTrack, { url: VALID_URL, reason: 'A' });
    await onA;

    const stopped = waitFor<RoomState>(
      controller,
      S2C.State,
      (s) => s.isPlaying === false && s.playbackError?.code === 2,
    );
    const errorLogged = waitFor<ActivityEntry>(controller, S2C.Activity, (a) => a.type === 'error');
    const ack = (await player.emitWithAck(C2S.PlaybackError, { code: 2 })) as Ack;
    expect(ack.ok).toBe(true);

    const [s, a] = await Promise.all([stopped, errorLogged]);
    expect(s.isPlaying).toBe(false);
    expect(s.playbackError?.code).toBe(2);
    expect(a.type).toBe('error');
  });

  it('ERR-03 rejects playbackError from a controller (player-only)', async () => {
    const room = 'ERR03';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const ack = (await controller.emitWithAck(C2S.PlaybackError, { code: 100 })) as Ack;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('player only');
  });

  it('NEXT-PLAYER a player may press 다음 곡 and advance the cursor', async () => {
    const room = 'NEXTPL';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // A becomes current; B appends behind it.
    const onA = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
    await controller.emitWithAck(C2S.ChangeTrack, { url: VALID_URL, reason: 'A' });
    await onA;
    const queued = waitFor<RoomState>(player, S2C.State, (s) =>
      upcoming(s).some((t) => t.id === '9bZkp7q19f0'),
    );
    await controller.emitWithAck(C2S.EnqueueTrack, { url: 'https://youtu.be/9bZkp7q19f0' });
    await queued;

    const advanced = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === '9bZkp7q19f0');
    const ack = (await player.emitWithAck(C2S.NextTrack, {})) as Ack;
    expect(ack.ok).toBe(true);

    const s = await advanced;
    expect(currentId(s)).toBe('9bZkp7q19f0');
    expect(upcoming(s).length).toBe(0);
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
    // state (with a current track) and the full activity log on join.
    const fresh = connect();
    const freshState = waitFor<RoomState>(fresh, S2C.State, (s) => currentId(s) === VALID_ID);
    const freshLog = waitFor<ActivityEntry[]>(fresh, S2C.ActivityLog, (log) =>
      log.some((e) => e.type === 'track_change'),
    );

    const joinAck = (await fresh.emitWithAck(C2S.Join, {
      roomCode: room,
      role: 'controller',
    })) as Ack;
    expect(joinAck.ok).toBe(true);

    const [s, log] = await Promise.all([freshState, freshLog]);
    expect(currentId(s)).toBe(VALID_ID);
    expect(log.some((e) => e.type === 'track_change')).toBe(true);
  });

  it('QUEUE-13 removeQueued (player) of an upcoming item keeps the current track and the rest', async () => {
    const room = 'QUEUE13';
    const SECOND_URL = 'https://youtu.be/9bZkp7q19f0';
    const THIRD_URL = 'https://youtu.be/3JZ_D3ELwOQ';
    const player = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // A becomes current (auto-start via changeTrack); B and C append → playlist
    // = [A(current,0), B(1), C(2)], upcoming = [B, C].
    const hasA = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
    await player.emitWithAck(C2S.ChangeTrack, { url: VALID_URL, reason: 'A' });
    await hasA;
    const built = waitFor<RoomState>(
      player,
      S2C.State,
      (s) => upcoming(s).length === 2 && upcoming(s)[1]?.id === '3JZ_D3ELwOQ',
    );
    await player.emitWithAck(C2S.EnqueueTrack, { url: SECOND_URL });
    await player.emitWithAck(C2S.EnqueueTrack, { url: THIRD_URL });
    await built;

    // Remove the upcoming head B (index 1): C remains upcoming, A stays current.
    const shrunk = waitFor<RoomState>(
      player,
      S2C.State,
      (s) => upcoming(s).length === 1 && upcoming(s)[0]?.id === '3JZ_D3ELwOQ',
    );
    const ack = (await player.emitWithAck(C2S.RemoveQueued, { index: 1 })) as Ack;
    expect(ack.ok).toBe(true);

    const s = await shrunk;
    expect(currentId(s)).toBe(VALID_ID);
    expect(upcoming(s).length).toBe(1);
    expect(upcoming(s)[0]?.id).toBe('3JZ_D3ELwOQ');
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

  it('TITLE-01 fills the current track title from the resolver when no title is given', async () => {
    const room = 'TITLE1';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    // The first state (from the ack/broadcast) may carry title null; the
    // predicate waits for the enriched re-broadcast.
    const enriched = waitFor<RoomState>(
      controller,
      S2C.State,
      (s) => currentTrack(s)?.title === 'Stub Title',
    );
    const ack = (await controller.emitWithAck(C2S.ChangeTrack, {
      url: VALID_URL,
      reason: 'set the vibe',
    })) as Ack;
    expect(ack.ok).toBe(true);

    const s = await enriched;
    expect(currentTrack(s)?.title).toBe('Stub Title');
  });

  it('TITLE-02 does not overwrite an explicitly provided title', async () => {
    const room = 'TITLE2';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const hasTrack = waitFor<RoomState>(controller, S2C.State, (s) => currentId(s) === VALID_ID);
    const ack = (await controller.emitWithAck(C2S.ChangeTrack, {
      url: VALID_URL,
      reason: 'set the vibe',
      title: 'My Title',
    })) as Ack;
    expect(ack.ok).toBe(true);

    const s = await hasTrack;
    expect(currentTrack(s)?.title).toBe('My Title');
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
    const sawTrack = waitFor<RoomState>(observer, S2C.State, (s) => currentId(s) === VALID_ID);
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

  it('GAIN-01b setTrackGain is allowed from a player too (guest event, both roles)', async () => {
    const room = 'GAIN01B';
    const player = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const hasGain = waitFor<RoomState>(player, S2C.State, (s) => s.trackGain.dQw4w9WgXcQ === 0.6);
    const ack = (await player.emitWithAck(C2S.SetTrackGain, {
      videoId: 'dQw4w9WgXcQ',
      gain: 0.6,
    })) as Ack;
    expect(ack.ok).toBe(true);
    expect((await hasGain).trackGain.dQw4w9WgXcQ).toBe(0.6);
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
  const THIRD_ID = 'kJQP7kiw5Fk';

  it('MODE-01 setRepeat (player) broadcasts state.repeat and logs a mode activity', async () => {
    const room = 'MODE01';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const repeatAll = (s: RoomState) => s.repeat === 'all';
    const isMode = (a: ActivityEntry) => a.type === 'mode';
    const controllerState = waitFor<RoomState>(controller, S2C.State, repeatAll);
    const controllerActivity = waitFor<ActivityEntry>(controller, S2C.Activity, isMode);

    // setRepeat is a MAIN action: player-only.
    const ack = (await player.emitWithAck(C2S.SetRepeat, { mode: 'all' })) as Ack;
    expect(ack.ok).toBe(true);

    const [cs, ca] = await Promise.all([controllerState, controllerActivity]);
    expect(cs.repeat).toBe('all');
    expect(ca.type).toBe('mode');
    expect((ca.detail as { repeat: string }).repeat).toBe('all');
  });

  it('MODE-01b rejects setRepeat from a controller (player only)', async () => {
    const room = 'MODE01B';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const ack = (await controller.emitWithAck(C2S.SetRepeat, { mode: 'all' })) as Ack;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('player only');
  });

  it('SHUFQ-01 shuffleQueue (player) reorders ONLY the upcoming items; current + played stay put', async () => {
    const room = 'SHUFQ01';
    const player = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // Build [A(current,0), B(1), C(2)] — A stays current; B,C are upcoming.
    const hasA = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
    await player.emitWithAck(C2S.ChangeTrack, { url: VALID_URL, reason: 'A' });
    await hasA;
    const built = waitFor<RoomState>(player, S2C.State, (s) => upcoming(s).length === 2);
    await player.emitWithAck(C2S.EnqueueTrack, { url: SECOND_URL });
    await player.emitWithAck(C2S.EnqueueTrack, { url: THIRD_URL });
    await built;

    const shuffled = waitFor<ActivityEntry>(
      player,
      S2C.Activity,
      (a) => a.type === 'mode' && (a.detail as { shuffledQueue?: boolean }).shuffledQueue === true,
    );
    const ack = (await player.emitWithAck(C2S.ShuffleQueue, {})) as Ack;
    expect(ack.ok).toBe(true);
    const a = await shuffled;
    expect((a.detail as { shuffledQueue: boolean }).shuffledQueue).toBe(true);

    // Probe a fresh broadcast and assert invariants: A is still current at
    // index 0, and the upcoming items are exactly {B, C} (a permutation).
    const probe = waitFor<RoomState>(player, S2C.State, (s) => s.volume === 33);
    await player.emitWithAck(C2S.SetVolume, { volume: 33 });
    const s = await probe;
    expect(s.currentIndex).toBe(0);
    expect(currentId(s)).toBe(VALID_ID);
    const upIds = upcoming(s)
      .map((t) => t.id)
      .sort();
    expect(upIds).toEqual([SECOND_ID, THIRD_ID].sort());
  });

  it('SHUFQ-02 shuffleQueue with fewer than 2 upcoming items is a no-op ok', async () => {
    const room = 'SHUFQ02';
    const player = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // Single track: A is current, nothing upcoming → no-op.
    const hasA = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
    await player.emitWithAck(C2S.ChangeTrack, { url: VALID_URL, reason: 'A' });
    await hasA;

    const ack = (await player.emitWithAck(C2S.ShuffleQueue, {})) as Ack;
    expect(ack.ok).toBe(true);
  });

  it('SHUFQ-03 rejects shuffleQueue from a controller (player only)', async () => {
    const room = 'SHUFQ03';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const ack = (await controller.emitWithAck(C2S.ShuffleQueue, {})) as Ack;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('player only');
  });

  it('REPEAT-ONE replays the current track on trackEnded (lastSeek 0, same track)', async () => {
    const room = 'REPONE';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    await player.emitWithAck(C2S.SetRepeat, { mode: 'one' });
    const hasA = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
    await controller.emitWithAck(C2S.ChangeTrack, { url: VALID_URL, reason: 'A' });
    await hasA;

    const replayed = waitFor<RoomState>(
      player,
      S2C.State,
      (s) => s.lastSeek?.seconds === 0 && currentId(s) === VALID_ID && s.isPlaying,
    );
    const ack = (await player.emitWithAck(C2S.TrackEnded, {})) as Ack;
    expect(ack.ok).toBe(true);

    const s = await replayed;
    expect(s.lastSeek?.seconds).toBe(0);
    expect(currentId(s)).toBe(VALID_ID);
    expect(s.isPlaying).toBe(true);
  });

  it('REPEAT-ALL wraps the cursor back to the playlist head when the end is reached', async () => {
    const room = 'REPALL';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    await player.emitWithAck(C2S.SetRepeat, { mode: 'all' });
    // Build [A(current,0), B(1)].
    const hasA = waitFor<RoomState>(player, S2C.State, (s) => currentId(s) === VALID_ID);
    await controller.emitWithAck(C2S.ChangeTrack, { url: VALID_URL, reason: 'A' });
    await hasA;
    const built = waitFor<RoomState>(player, S2C.State, (s) => s.playlist.length === 2);
    await controller.emitWithAck(C2S.EnqueueTrack, { url: SECOND_URL });
    await built;

    // First trackEnded advances the cursor to B (index 1).
    const onB = waitFor<RoomState>(
      player,
      S2C.State,
      (s) => s.currentIndex === 1 && currentId(s) === SECOND_ID,
    );
    expect(((await player.emitWithAck(C2S.TrackEnded, {})) as Ack).ok).toBe(true);
    const sB = await onB;
    expect(currentId(sB)).toBe(SECOND_ID);

    // Second trackEnded: cursor is at the end + repeat 'all' wraps back to A (0).
    const wrapped = waitFor<RoomState>(
      player,
      S2C.State,
      (s) => s.currentIndex === 0 && currentId(s) === VALID_ID && s.isPlaying,
    );
    expect(((await player.emitWithAck(C2S.TrackEnded, {})) as Ack).ok).toBe(true);
    const sA = await wrapped;
    expect(sA.currentIndex).toBe(0);
    expect(currentId(sA)).toBe(VALID_ID);
    expect(sA.isPlaying).toBe(true);
  });

  it('OFF-STOP stops playback (keeping the cursor) when the end is reached under repeat off', async () => {
    const room = 'OFFSTP';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // repeat defaults to 'off'.
    const playing = waitFor<RoomState>(
      player,
      S2C.State,
      (s) => currentId(s) === VALID_ID && s.isPlaying,
    );
    await controller.emitWithAck(C2S.ChangeTrack, { url: VALID_URL, reason: 'A' });
    await playing;

    const stopped = waitFor<RoomState>(
      player,
      S2C.State,
      (s) => s.isPlaying === false && currentId(s) === VALID_ID,
    );
    const ack = (await player.emitWithAck(C2S.TrackEnded, {})) as Ack;
    expect(ack.ok).toBe(true);

    const s = await stopped;
    expect(s.isPlaying).toBe(false);
    // The cursor stays on the last (only) track.
    expect(currentId(s)).toBe(VALID_ID);
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

      const advanced = waitFor<RoomState>(controller, S2C.State, (s) => currentId(s) === VALID_ID);
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

  it('SCHED-01 a player setSchedule broadcasts state.schedule + logs a schedule activity', async () => {
    const room = 'SCHED1';
    const player = connect();
    const observer = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });
    await observer.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const enabled = (s: RoomState) => s.schedule?.enabled === true;
    const isSchedule = (a: ActivityEntry) => a.type === 'schedule';
    const obsState = waitFor<RoomState>(observer, S2C.State, enabled);
    const obsActivity = waitFor<ActivityEntry>(observer, S2C.Activity, isSchedule);

    const ack = (await player.emitWithAck(C2S.SetSchedule, {
      schedule: monSchedule(),
    })) as Ack;
    expect(ack.ok).toBe(true);

    const [os, oa] = await Promise.all([obsState, obsActivity]);
    expect(os.schedule?.enabled).toBe(true);
    expect(oa.type).toBe('schedule');
  });

  it('SCHED-02 rejects an invalid schedule from a player (start>end or bad HH:MM)', async () => {
    const room = 'SCHED2';
    const player = connect();
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    const badRange = monSchedule();
    badRange.days.mon = { on: true, start: '18:00', end: '09:00' };
    const rangeAck = (await player.emitWithAck(C2S.SetSchedule, {
      schedule: badRange,
    })) as Ack;
    expect(rangeAck.ok).toBe(false);
    expect(rangeAck.error).toBe('invalid schedule');

    const badTime = monSchedule();
    badTime.days.mon = { on: true, start: '09:00', end: '25:99' };
    const timeAck = (await player.emitWithAck(C2S.SetSchedule, {
      schedule: badTime,
    })) as Ack;
    expect(timeAck.ok).toBe(false);
    expect(timeAck.error).toBe('invalid schedule');
  });

  it('SCHED-06 rejects setSchedule from a controller (player-only)', async () => {
    const room = 'SCHED6';
    const controller = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });

    const ack = (await controller.emitWithAck(C2S.SetSchedule, {
      schedule: monSchedule(),
    })) as Ack;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('player only');
  });

  it('SCHED-03 auto-starts playback on the schedule edge inside the window', async () => {
    const room = 'SCHED3';
    const controller = connect();
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    // Schedule is a player (device) setting; track/playback control is controller.
    await player.emitWithAck(C2S.SetSchedule, { schedule: monSchedule() });
    const hasTrack = waitFor<RoomState>(controller, S2C.State, (s) => currentId(s) === VALID_ID);
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
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    await player.emitWithAck(C2S.SetSchedule, { schedule: monSchedule() });
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
    const player = connect();
    await controller.emitWithAck(C2S.Join, { roomCode: room, role: 'controller' });
    await player.emitWithAck(C2S.Join, { roomCode: room, role: 'player' });

    await player.emitWithAck(C2S.SetSchedule, { schedule: monSchedule() });
    const hasTrack = waitFor<RoomState>(controller, S2C.State, (s) => currentId(s) === VALID_ID);
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
