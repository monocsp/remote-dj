import { type Server as HttpServer, createServer as createHttpServer } from 'node:http';
import {
  type Ack,
  type ActivityEntry,
  type ActivityType,
  C2S,
  type ChangeTrackPayload,
  type EnqueueTrackPayload,
  type JoinPayload,
  LIMITS,
  type NextTrackPayload,
  type PlaybackErrorPayload,
  type ProgressPayload,
  type RemoveQueuedPayload,
  type Role,
  type RoomSettings,
  type RoomState,
  S2C,
  type SeekToPayload,
  type SetTrackGainPayload,
  type SetVolumePayload,
  type TogglePlayPayload,
  type Track,
  type UpdateSettingsPayload,
  clampGain,
  clampVolume,
  parseYouTubeId,
  validateReason,
  withinLimit,
} from '@remote-dj/shared';
import { nanoid } from 'nanoid';
import { Server } from 'socket.io';
import { InMemoryRoomStore, type RoomStore } from './store.js';

interface SocketData {
  roomCode?: string;
  role?: Role;
  nickname?: string | null;
}

type AckFn = (res: Ack) => void;

/** Grace period before an empty room is deleted, allowing quick reconnects. */
const ROOM_TTL_MS = 5 * 60_000;

/** Timeout for the YouTube oEmbed title lookup. */
const TITLE_FETCH_TIMEOUT_MS = 3_000;

/** Timeout for the (unofficial) YouTube loudness lookup. */
const LOUDNESS_FETCH_TIMEOUT_MS = 4_000;

/**
 * Best-effort resolver for a YouTube track title via the public oEmbed endpoint.
 * Never throws: returns the title string on success, or null on any
 * error/timeout/non-ok response. When REMOTE_DJ_FAKE_TITLE is set, returns it
 * without any network access (deterministic tests / black-box QA).
 */
export async function defaultResolveTitle(url: string): Promise<string | null> {
  const fake = process.env.REMOTE_DJ_FAKE_TITLE;
  if (fake) return fake;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TITLE_FETCH_TIMEOUT_MS);
  try {
    const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetch(oembed, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { title?: unknown };
    return typeof data.title === 'string' ? data.title : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort resolver for a YouTube track's integrated loudness (dB) via the
 * UNOFFICIAL innertube player endpoint (`playerConfig.audioConfig.loudnessDb`).
 * This endpoint is undocumented and may break at any time — see docs/SPEC.md
 * §음량 정규화. Never throws: returns the loudnessDb number on success, or null
 * on any error/timeout/non-ok response. When REMOTE_DJ_FAKE_LOUDNESS is set,
 * returns Number(env) without any network access (deterministic tests / QA).
 */
export async function defaultResolveLoudness(videoId: string): Promise<number | null> {
  const fake = process.env.REMOTE_DJ_FAKE_LOUDNESS;
  if (fake != null && fake !== '') {
    const n = Number(fake);
    return Number.isFinite(n) ? n : null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOUDNESS_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      'https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          videoId,
          context: { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00' } },
        }),
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      playerConfig?: { audioConfig?: { loudnessDb?: unknown } };
    };
    const loudness = data.playerConfig?.audioConfig?.loudnessDb;
    return typeof loudness === 'number' && Number.isFinite(loudness) ? loudness : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wire an HTTP server + Socket.IO Server with all room handlers.
 * Exported (not auto-listening) so tests can listen on an ephemeral port.
 */
export function createServer(
  store: RoomStore = new InMemoryRoomStore(),
  resolveTitle: (url: string) => Promise<string | null> = defaultResolveTitle,
  resolveLoudness: (videoId: string) => Promise<number | null> = defaultResolveLoudness,
): {
  httpServer: HttpServer;
  io: Server;
} {
  const httpServer = createHttpServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const io = new Server(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN ?? '*' },
  });

  // Pending deletions for rooms that went empty; cancelled if someone rejoins.
  const pendingDeletions = new Map<string, NodeJS.Timeout>();

  /** Cancel any scheduled deletion for a room (e.g. on rejoin). */
  function cancelDeletion(roomCode: string): void {
    const timer = pendingDeletions.get(roomCode);
    if (timer) {
      clearTimeout(timer);
      pendingDeletions.delete(roomCode);
    }
  }

  /** Recompute presence from connected sockets and broadcast `state`. */
  async function broadcastState(roomCode: string): Promise<void> {
    const record = await store.get(roomCode);
    if (!record) return;

    const sockets = await io.in(roomCode).fetchSockets();
    let controllers = 0;
    let playerConnected = false;
    for (const s of sockets) {
      const data = s.data as SocketData;
      if (data.role === 'controller') controllers++;
      if (data.role === 'player') playerConnected = true;
    }

    const state: RoomState = {
      ...record.state,
      presence: { playerConnected, controllers },
    };
    io.to(roomCode).emit(S2C.State, state);
  }

  /**
   * Resolve a track's title (best-effort) and, if found, patch it onto the
   * matching currentTrack / queue items that still lack a title, then
   * re-broadcast. Fire-and-forget from the handlers so the original
   * ack/broadcast is never delayed. Never throws.
   */
  async function enrichTitle(roomCode: string, url: string, id: string): Promise<void> {
    const title = await resolveTitle(url);
    if (!title) return;
    const rec = await store.get(roomCode);
    if (!rec) return;

    let changed = false;
    let currentTrack = rec.state.currentTrack;
    if (currentTrack && currentTrack.id === id && !currentTrack.title) {
      currentTrack = { ...currentTrack, title };
      changed = true;
    }
    const queue = rec.state.queue.map((t) => {
      if (t.id === id && !t.title) {
        changed = true;
        return { ...t, title };
      }
      return t;
    });

    if (!changed) return;
    await store.patchState(roomCode, { currentTrack, queue });
    await broadcastState(roomCode);
  }

  /**
   * Auto-seed (B) the per-track loudness gain from YouTube's loudnessDb.
   * Fire-and-forget mirror of enrichTitle: best-effort, never throws, never
   * delays the original ack/broadcast. A MANUAL/existing gain always wins — if
   * one is already set for this videoId we leave it untouched. On lookup
   * failure (null) it is a no-op. Computes the attenuation factor that would
   * bring this track to YouTube's reference (factor = 10^(-loudnessDb/20),
   * capped at 1) and only persists it when attenuation is actually needed
   * (factor < 1) to avoid a pointless no-op patch. NOT recorded as an activity
   * (auto-seed should not spam the log).
   */
  async function enrichGain(roomCode: string, videoId: string): Promise<void> {
    const existing = await store.get(roomCode);
    if (!existing) return;
    // Manual / existing gain wins — never overwrite it via auto-seed.
    if (existing.state.trackGain[videoId] !== undefined) return;

    const loudness = await resolveLoudness(videoId);
    if (loudness == null) return;

    const factor = clampGain(Math.min(1, 10 ** (-loudness / 20)));
    // Skip the no-op: only persist when actual attenuation is needed.
    if (factor >= 1) return;

    const rec = await store.get(roomCode);
    if (!rec) return;
    // Re-check after the await: a manual gain may have arrived meanwhile.
    if (rec.state.trackGain[videoId] !== undefined) return;
    await store.patchState(roomCode, {
      trackGain: { ...rec.state.trackGain, [videoId]: factor },
    });
    await broadcastState(roomCode);
  }

  io.on('connection', (socket) => {
    const data = socket.data as SocketData;

    /** Build, persist and broadcast an ActivityEntry for this socket's room. */
    async function recordActivity(
      type: ActivityType,
      reason: string | null,
      detail?: Record<string, unknown>,
    ): Promise<void> {
      const roomCode = data.roomCode;
      if (!roomCode) return;
      const entry: ActivityEntry = {
        id: nanoid(8),
        ts: Date.now(),
        actor: data.nickname ?? null,
        type,
        reason,
        detail,
      };
      await store.appendActivity(roomCode, entry);
      io.to(roomCode).emit(S2C.Activity, entry);
    }

    /** Guard: only controllers may emit control events. */
    function requireController(ack: AckFn): string | null {
      if (data.role !== 'controller') {
        ack({ ok: false, error: 'controllers only' });
        return null;
      }
      if (!data.roomCode) {
        ack({ ok: false, error: 'not in a room' });
        return null;
      }
      return data.roomCode;
    }

    /** Guard: only the player may emit player status reports. */
    function requirePlayer(ack: AckFn): string | null {
      if (data.role !== 'player') {
        ack({ ok: false, error: 'player only' });
        return null;
      }
      if (!data.roomCode) {
        ack({ ok: false, error: 'not in a room' });
        return null;
      }
      return data.roomCode;
    }

    /**
     * Anonymity gate for CONTENT actions (changeTrack/enqueueTrack/nextTrack).
     * When a room has settings.allowAnonymous === false and this socket has no
     * nickname, ack { ok:false, error:'nickname required' } and return true.
     * Applied AFTER requireController so authorization is checked first. NOT
     * applied to setVolume/togglePlay/seekTo/updateSettings/trackEnded/progress
     * — that keeps low-stakes controls open and (critically) updateSettings
     * editable so the room can never lock itself out.
     */
    async function anonymityBlocked(room: string, ack: AckFn): Promise<boolean> {
      const record = await store.getOrCreate(room);
      if (record.state.settings.allowAnonymous === false && !data.nickname) {
        ack({ ok: false, error: 'nickname required' });
        return true;
      }
      return false;
    }

    socket.on(C2S.Join, async (payload: JoinPayload, ack: AckFn) => {
      const { roomCode, role, nickname, password } = payload ?? ({} as JoinPayload);
      if (!roomCode || !role) {
        ack({ ok: false, error: 'roomCode and role required' });
        return;
      }
      if (!withinLimit(nickname, LIMITS.nickname)) {
        ack({ ok: false, error: 'nickname too long' });
        return;
      }
      if (!withinLimit(password, LIMITS.password)) {
        ack({ ok: false, error: 'password too long' });
        return;
      }

      // Optional room password. The room is created on first join; the first
      // joiner sets the password (empty/absent → open room). Check BEFORE
      // joining the socket / mutating socket.data / broadcasting.
      const existing = await store.get(roomCode);
      if (existing && existing.password !== null) {
        if ((password ?? '').trim() !== existing.password) {
          ack({ ok: false, error: 'wrong password' });
          return;
        }
      }

      // A socket lives in exactly one app room: leave any previous one first
      // and refresh its presence so it no longer counts this socket.
      const previousRoom = data.roomCode;
      if (previousRoom && previousRoom !== roomCode) {
        await socket.leave(previousRoom);
      }

      cancelDeletion(roomCode);
      await socket.join(roomCode);
      data.roomCode = roomCode;
      data.role = role;
      data.nickname = nickname ?? null;

      if (previousRoom && previousRoom !== roomCode) {
        await broadcastState(previousRoom);
      }

      // On create (room didn't exist before this join), the first joiner sets
      // the optional password; an empty/absent value yields an open room.
      const record = existing
        ? await store.getOrCreate(roomCode)
        : await store.getOrCreate(roomCode, password?.trim() || null);

      // Send current state (with recomputed presence) + full log to this socket.
      const sockets = await io.in(roomCode).fetchSockets();
      let controllers = 0;
      let playerConnected = false;
      for (const s of sockets) {
        const d = s.data as SocketData;
        if (d.role === 'controller') controllers++;
        if (d.role === 'player') playerConnected = true;
      }
      socket.emit(S2C.State, {
        ...record.state,
        presence: { playerConnected, controllers },
      });
      socket.emit(S2C.ActivityLog, record.log);

      // Notify the rest of the room of the new presence.
      await broadcastState(roomCode);
      ack({ ok: true });
    });

    socket.on(C2S.ChangeTrack, async (payload: ChangeTrackPayload, ack: AckFn) => {
      const room = requireController(ack);
      if (!room) return;
      if (await anonymityBlocked(room, ack)) return;
      const { url, reason, title } = payload ?? ({} as ChangeTrackPayload);

      if (
        !withinLimit(url, LIMITS.url) ||
        !withinLimit(reason, LIMITS.reason) ||
        !withinLimit(title, LIMITS.title)
      ) {
        ack({ ok: false, error: 'input too long' });
        return;
      }
      if (!validateReason(reason ?? '')) {
        ack({ ok: false, error: 'reason required' });
        return;
      }
      const id = parseYouTubeId(url);
      if (!id) {
        ack({ ok: false, error: 'invalid youtube url' });
        return;
      }

      const track: Track = {
        id,
        url,
        title: title ?? null,
        addedBy: data.nickname ?? null,
      };
      await store.patchState(room, { currentTrack: track, isPlaying: true, playbackError: null });
      await recordActivity('track_change', reason.trim(), { id, url, title: track.title });
      ack({ ok: true });
      await broadcastState(room);
      // No title provided: fill it from YouTube oEmbed asynchronously and
      // re-broadcast. Fire-and-forget so ack/broadcast timing is unchanged.
      if (!track.title) void enrichTitle(room, url, id);
      // Auto-seed (B) the loudness gain best-effort; never overwrites manual.
      void enrichGain(room, id);
    });

    socket.on(C2S.SetVolume, async (payload: SetVolumePayload, ack: AckFn) => {
      const room = requireController(ack);
      if (!room) return;
      const { volume, reason } = payload ?? ({} as SetVolumePayload);
      if (!withinLimit(reason, LIMITS.reason)) {
        ack({ ok: false, error: 'input too long' });
        return;
      }
      const clamped = clampVolume(volume);

      await store.patchState(room, { volume: clamped });
      await recordActivity('volume', reason?.trim() || null, { volume: clamped });
      ack({ ok: true });
      await broadcastState(room);
    });

    socket.on(C2S.TogglePlay, async (payload: TogglePlayPayload, ack: AckFn) => {
      const room = requireController(ack);
      if (!room) return;
      const { isPlaying, reason } = payload ?? ({} as TogglePlayPayload);
      if (!withinLimit(reason, LIMITS.reason)) {
        ack({ ok: false, error: 'input too long' });
        return;
      }

      await store.patchState(room, { isPlaying });
      await recordActivity(isPlaying ? 'play' : 'pause', reason?.trim() || null);
      ack({ ok: true });
      await broadcastState(room);
    });

    socket.on(C2S.UpdateSettings, async (payload: UpdateSettingsPayload, ack: AckFn) => {
      const room = requireController(ack);
      if (!room) return;
      const { settings, reason } = payload ?? ({} as UpdateSettingsPayload);
      if (!withinLimit(reason, LIMITS.reason)) {
        ack({ ok: false, error: 'input too long' });
        return;
      }

      const record = await store.getOrCreate(room);
      const merged: RoomSettings = { ...record.state.settings, ...settings };
      await store.patchState(room, { settings: merged });
      await recordActivity('settings', reason?.trim() || null, settings);
      ack({ ok: true });
      await broadcastState(room);
    });

    socket.on(C2S.EnqueueTrack, async (payload: EnqueueTrackPayload, ack: AckFn) => {
      const room = requireController(ack);
      if (!room) return;
      if (await anonymityBlocked(room, ack)) return;
      const { url, reason, title } = payload ?? ({} as EnqueueTrackPayload);

      if (
        !withinLimit(url, LIMITS.url) ||
        !withinLimit(reason, LIMITS.reason) ||
        !withinLimit(title, LIMITS.title)
      ) {
        ack({ ok: false, error: 'input too long' });
        return;
      }
      // Unlike changeTrack, enqueue reason is OPTIONAL — no validateReason check.
      const id = parseYouTubeId(url);
      if (!id) {
        ack({ ok: false, error: 'invalid youtube url' });
        return;
      }

      const track: Track = {
        id,
        url,
        title: title ?? null,
        addedBy: data.nickname ?? null,
      };
      const record = await store.getOrCreate(room);
      await store.patchState(room, { queue: [...record.state.queue, track] });
      await recordActivity('enqueue', reason?.trim() || null, { id, url, title: track.title });
      ack({ ok: true });
      await broadcastState(room);
      // No title provided: fill it from YouTube oEmbed asynchronously and
      // re-broadcast. Fire-and-forget so ack/broadcast timing is unchanged.
      if (!track.title) void enrichTitle(room, url, id);
      // Auto-seed (B) the loudness gain best-effort; never overwrites manual.
      void enrichGain(room, id);
    });

    socket.on(C2S.RemoveQueued, async (payload: RemoveQueuedPayload, ack: AckFn) => {
      const room = requireController(ack);
      if (!room) return;
      const { index, reason } = payload ?? ({} as RemoveQueuedPayload);
      if (!withinLimit(reason, LIMITS.reason)) {
        ack({ ok: false, error: 'input too long' });
        return;
      }

      const record = await store.getOrCreate(room);
      const queue = record.state.queue;
      if (!Number.isInteger(index) || index < 0 || index >= queue.length) {
        ack({ ok: false, error: 'invalid index' });
        return;
      }

      const next = [...queue.slice(0, index), ...queue.slice(index + 1)];
      await store.patchState(room, { queue: next });
      await recordActivity('dequeue', reason?.trim() || null, { index });
      ack({ ok: true });
      await broadcastState(room);
    });

    socket.on(C2S.NextTrack, async (payload: NextTrackPayload, ack: AckFn) => {
      const room = requireController(ack);
      if (!room) return;
      if (await anonymityBlocked(room, ack)) return;
      const { reason } = payload ?? ({} as NextTrackPayload);
      if (!withinLimit(reason, LIMITS.reason)) {
        ack({ ok: false, error: 'input too long' });
        return;
      }

      const record = await store.getOrCreate(room);
      const queue = record.state.queue;
      if (queue.length === 0) {
        // Nothing queued: no-op success, no broadcast needed.
        ack({ ok: true });
        return;
      }

      const [head, ...rest] = queue;
      await store.patchState(room, {
        currentTrack: head,
        queue: rest,
        isPlaying: true,
        playbackError: null,
      });
      await recordActivity('skip', reason?.trim() || null, { id: head.id });
      ack({ ok: true });
      await broadcastState(room);
    });

    socket.on(C2S.TrackEnded, async (_payload, ack: AckFn) => {
      const room = requirePlayer(ack);
      if (!room) return;

      // Behaves like an automatic next: advance the queue if anything is queued,
      // otherwise just stop playing.
      const record = await store.getOrCreate(room);
      const queue = record.state.queue;
      if (queue.length === 0) {
        await store.patchState(room, { isPlaying: false });
        ack({ ok: true });
        await broadcastState(room);
        return;
      }

      const [head, ...rest] = queue;
      await store.patchState(room, {
        currentTrack: head,
        queue: rest,
        isPlaying: true,
        playbackError: null,
      });
      await recordActivity('skip', null, { auto: true });
      ack({ ok: true });
      await broadcastState(room);
    });

    socket.on(C2S.SeekTo, async (payload: SeekToPayload, ack: AckFn) => {
      const room = requireController(ack);
      if (!room) return;
      const { seconds, reason } = payload ?? ({} as SeekToPayload);
      if (!withinLimit(reason, LIMITS.reason)) {
        ack({ ok: false, error: 'input too long' });
        return;
      }
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
        ack({ ok: false, error: 'invalid seconds' });
        return;
      }

      await store.patchState(room, { lastSeek: { seconds, ts: Date.now() } });
      await recordActivity('seek', reason?.trim() || null, { seconds });
      ack({ ok: true });
      await broadcastState(room);
    });

    socket.on(C2S.Progress, async (payload: ProgressPayload, ack: AckFn) => {
      const room = requirePlayer(ack);
      if (!room) return;
      const { currentTime, duration } = payload ?? ({} as ProgressPayload);
      if (
        typeof currentTime !== 'number' ||
        !Number.isFinite(currentTime) ||
        currentTime < 0 ||
        typeof duration !== 'number' ||
        !Number.isFinite(duration) ||
        duration < 0
      ) {
        ack({ ok: false, error: 'invalid progress' });
        return;
      }

      // High-frequency report: update state but DO NOT log an activity entry
      // (would spam the log; Player throttles to ~2s).
      await store.patchState(room, { progress: { currentTime, duration, ts: Date.now() } });
      ack({ ok: true });
      await broadcastState(room);
    });

    socket.on(C2S.PlaybackError, async (payload: PlaybackErrorPayload, ack: AckFn) => {
      const room = requirePlayer(ack);
      if (!room) return;
      const { code } = payload ?? ({} as PlaybackErrorPayload);
      if (typeof code !== 'number' || !Number.isFinite(code)) {
        ack({ ok: false, error: 'invalid code' });
        return;
      }

      // A status, surfaced via RoomState only (like progress) — NOT logged.
      await store.patchState(room, { playbackError: { code, ts: Date.now() } });
      ack({ ok: true });
      await broadcastState(room);
    });

    socket.on(C2S.SetTrackGain, async (payload: SetTrackGainPayload, ack: AckFn) => {
      const room = requireController(ack);
      if (!room) return;
      const { videoId, gain, reason } = payload ?? ({} as SetTrackGainPayload);
      if (!withinLimit(reason, LIMITS.reason)) {
        ack({ ok: false, error: 'input too long' });
        return;
      }
      if (typeof videoId !== 'string' || videoId === '') {
        ack({ ok: false, error: 'invalid videoId' });
        return;
      }
      const g = clampGain(gain);

      const record = await store.getOrCreate(room);
      await store.patchState(room, {
        trackGain: { ...record.state.trackGain, [videoId]: g },
      });
      await recordActivity('gain', reason?.trim() || null, { videoId, gain: g });
      ack({ ok: true });
      await broadcastState(room);
    });

    socket.on('disconnect', async () => {
      const room = data.roomCode;
      if (!room) return;
      await broadcastState(room);

      // If the room is now empty, schedule its deletion after a grace period.
      const remaining = (await io.in(room).fetchSockets()).length;
      if (remaining === 0 && !pendingDeletions.has(room)) {
        const timer = setTimeout(() => {
          pendingDeletions.delete(room);
          void store.deleteRoom(room);
        }, ROOM_TTL_MS);
        pendingDeletions.set(room, timer);
      }
    });
  });

  return { httpServer, io };
}

// Auto-start unless imported (e.g. by tests).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { httpServer } = createServer();
  const port = Number(process.env.PORT ?? 3001);
  const hostname = process.env.HOSTNAME ?? '0.0.0.0';
  httpServer.listen(port, hostname, () => {
    console.log(`remote-dj server listening on http://${hostname}:${port}`);
  });
}
