import { type Server as HttpServer, createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import {
  type Ack,
  type ActivityEntry,
  type ActivityType,
  C2S,
  type ChangeTrackPayload,
  type DayKey,
  type EnqueueTrackPayload,
  type JoinPayload,
  LIMITS,
  type NextTrackPayload,
  type PlaybackErrorPayload,
  type ProgressPayload,
  type RemoveQueuedPayload,
  type RepeatMode,
  type Role,
  type RoomSettings,
  type RoomState,
  S2C,
  type SeekToPayload,
  type SetRepeatPayload,
  type SetSchedulePayload,
  type SetShufflePayload,
  type SetTrackGainPayload,
  type SetVolumePayload,
  type TogglePlayPayload,
  type Track,
  type UpdateSettingsPayload,
  type WeeklySchedule,
  clampGain,
  clampVolume,
  isHHMM,
  parseYouTubeId,
  validateReason,
  withinLimit,
} from '@remote-dj/shared';
import { nanoid } from 'nanoid';
import { Server } from 'socket.io';
import { PersistentRoomStore } from './persistentStore.js';
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

/** Timeout for the YouTube oEmbed embeddability check. */
const EMBEDDABLE_FETCH_TIMEOUT_MS = 3_000;

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
 * Best-effort check of whether a YouTube URL is embeddable / available, via the
 * public oEmbed endpoint. Used to reject non-embeddable videos at add time
 * (changeTrack/enqueueTrack). Never throws. Returns:
 *  - true  → embeddable (oEmbed 200), proceed.
 *  - false → embedding disabled / video unavailable (oEmbed 401 or 404), reject.
 *  - null  → UNKNOWN (other status / network error / timeout) → fail open, proceed.
 * When REMOTE_DJ_FAKE_TITLE is set, returns true without any network access
 * (deterministic tests / black-box QA).
 */
export async function defaultResolveEmbeddable(url: string): Promise<boolean | null> {
  if (process.env.REMOTE_DJ_FAKE_TITLE) return true;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBEDDABLE_FETCH_TIMEOUT_MS);
  try {
    const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetch(oembed, { signal: controller.signal });
    if (res.status === 200) return true;
    if (res.status === 401 || res.status === 404) return false;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Map a YouTube IFrame API error code to a Korean human-readable message. */
function playbackErrorMessage(code: number): string {
  switch (code) {
    case 2:
      return '잘못된 링크';
    case 5:
      return 'HTML5 재생 오류';
    case 100:
      return '영상을 찾을 수 없음';
    case 101:
    case 150:
      return '임베드가 비활성화된 영상';
    default:
      return '재생 오류';
  }
}

/**
 * Pick the index of the next track from a list of length `len`:
 * a random index when shuffle is on, otherwise the head (0). Math.random is
 * allowed server-side. Callers ensure `len > 0`.
 */
function pickIndex(len: number, shuffle: boolean): number {
  return shuffle ? Math.floor(Math.random() * len) : 0;
}

/** Return a shuffled copy of `a` (Fisher–Yates). Does not mutate the input. */
function shuffledCopy<T>(a: T[]): T[] {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ── Weekly schedule helpers (pure) ────────────────────────────────────────
// Indexed by Date.getDay() (0 = Sunday) so DAY_KEYS[now.getDay()] maps a JS
// date to the matching DaySchedule key.
const DAY_KEYS: DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Zero-padded local "HH:MM" for `d`. */
function hhmm(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Does the schedule want playback ON at `now`?
 *  - null / disabled schedule → null (NO opinion; scheduler skips the room).
 *  - day off → false.
 *  - otherwise true iff the current local "HH:MM" is in [start, end).
 */
function scheduleWantsPlay(schedule: WeeklySchedule | null, now: Date): boolean | null {
  if (!schedule || !schedule.enabled) return null;
  const day = schedule.days[DAY_KEYS[now.getDay()]];
  if (!day || !day.on) return false;
  const cur = hhmm(now);
  return day.start <= cur && cur < day.end;
}

/**
 * Validate a WeeklySchedule (only when non-null). Requires: enabled boolean,
 * all 7 day keys present, each day.on boolean with valid HH:MM start/end and
 * start < end. Returns true when the schedule is structurally acceptable.
 */
function isValidSchedule(schedule: WeeklySchedule): boolean {
  if (typeof schedule.enabled !== 'boolean') return false;
  if (!schedule.days || typeof schedule.days !== 'object') return false;
  for (const key of DAY_KEYS) {
    const day = schedule.days[key];
    if (!day || typeof day !== 'object') return false;
    if (typeof day.on !== 'boolean') return false;
    if (!isHHMM(day.start) || !isHHMM(day.end)) return false;
    if (!(day.start < day.end)) return false;
  }
  return true;
}

/**
 * Wire an HTTP server + Socket.IO Server with all room handlers.
 * Exported (not auto-listening) so tests can listen on an ephemeral port.
 */
export function createServer(
  store: RoomStore = new InMemoryRoomStore(),
  resolveTitle: (url: string) => Promise<string | null> = defaultResolveTitle,
  resolveLoudness: (videoId: string) => Promise<number | null> = defaultResolveLoudness,
  resolveEmbeddable: (url: string) => Promise<boolean | null> = defaultResolveEmbeddable,
): {
  httpServer: HttpServer;
  io: Server;
  // Exposed so tests can drive the scheduler with an injected `now` instead of
  // waiting on the wall clock. Backward-compatible: existing callers that only
  // destructure { httpServer, io } are unaffected.
  tickSchedules: (now: Date) => Promise<void>;
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
   * Room-level activity logger. recordActivity is per-socket (uses the
   * socket's nickname as actor); this mirrors its shape for server-originated
   * events (e.g. the scheduler) with a null actor.
   */
  async function roomLog(
    roomCode: string,
    type: ActivityType,
    reason: string | null,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    const entry: ActivityEntry = {
      id: nanoid(8),
      ts: Date.now(),
      actor: null,
      type,
      reason,
      detail,
    };
    await store.appendActivity(roomCode, entry);
    io.to(roomCode).emit(S2C.Activity, entry);
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

  /**
   * Shared advance logic for BOTH manual next (controller) and auto end
   * (player trackEnded). Always moves to a DIFFERENT next track — the
   * repeat-'one' replay is handled by the trackEnded caller, never here.
   *
   * Source of the next track:
   *  - queue non-empty: push the current track into server-only history, then
   *    pick from the queue (head, or random when shuffle).
   *  - queue empty + repeat 'all': rebuild the pool from everything played
   *    (history + current), reset history, play the first (order shuffled when
   *    shuffle is on).
   *  - queue empty + 'off'/'one': stop (isPlaying:false), keep currentTrack.
   *
   * `log` records the resulting activity (skip) — auto end passes a null actor
   * with detail {auto:true}; manual next passes the controller's reason.
   */
  async function advance(
    roomCode: string,
    log: (detail: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    const record = await store.getOrCreate(roomCode);
    const { currentTrack: cur, queue, repeat, shuffle } = record.state;

    let next: Track;
    let rest: Track[];

    if (queue.length > 0) {
      // Remember the track we are leaving so repeat-'all' can replay it later.
      if (cur) await store.setHistory(roomCode, [...record.history, cur]);
      const i = pickIndex(queue.length, shuffle);
      next = queue[i];
      rest = [...queue.slice(0, i), ...queue.slice(i + 1)];
    } else if (repeat === 'all') {
      const all = [...record.history, ...(cur ? [cur] : [])];
      if (all.length === 0) {
        // Nothing has ever played: nothing to loop, just stop.
        await store.patchState(roomCode, { isPlaying: false });
        await broadcastState(roomCode);
        return;
      }
      const pool = shuffle ? shuffledCopy(all) : all;
      await store.setHistory(roomCode, []);
      next = pool[0];
      rest = pool.slice(1);
    } else {
      // repeat 'off' or 'one' with an empty queue: stop, keep current.
      await store.patchState(roomCode, { isPlaying: false });
      await broadcastState(roomCode);
      return;
    }

    await store.patchState(roomCode, {
      currentTrack: next,
      queue: rest,
      isPlaying: true,
      playbackError: null,
    });
    await log({ id: next.id });
    await broadcastState(roomCode);
  }

  // ── Weekly schedule scheduler ────────────────────────────────────────────
  // Per-room memory of the last computed "want" so transitions are
  // EDGE-triggered: we only act when the desired state CHANGES, never on every
  // tick. This is what stops the scheduler from fighting manual control inside
  // an open window (a manual pause mid-window won't be re-played until the next
  // schedule edge). A `null` want (no/disabled schedule) is "no opinion" and is
  // never recorded as an edge.
  const lastWant = new Map<string, boolean | null>();

  /**
   * Evaluate every room's schedule against `now` and apply edge transitions.
   * Returned from createServer so tests can inject a deterministic `now`.
   */
  async function tickSchedules(now: Date): Promise<void> {
    for (const code of await store.listRoomCodes()) {
      const rec = await store.get(code);
      if (!rec) continue;
      const want = scheduleWantsPlay(rec.state.schedule, now);
      if (want === null) continue; // no opinion → leave the room alone

      const prev = lastWant.get(code);
      lastWant.set(code, want);
      if (want === prev) continue; // act only on the EDGE

      if (want === true && !rec.state.isPlaying) {
        // Start playback: resume the current track, else promote the queue
        // head, else just flip the flag (nothing to play — harmless).
        if (rec.state.currentTrack) {
          await store.patchState(code, { isPlaying: true });
        } else if (rec.state.queue.length > 0) {
          await advance(code, (detail) => roomLog(code, 'skip', null, { auto: true, ...detail }));
        } else {
          await store.patchState(code, { isPlaying: true });
        }
        await roomLog(code, 'schedule', null, { auto: true, action: 'play' });
        await broadcastState(code);
      } else if (want === false && rec.state.isPlaying) {
        await store.patchState(code, { isPlaying: false });
        await roomLog(code, 'schedule', null, { auto: true, action: 'stop' });
        await broadcastState(code);
      }
    }
  }

  // Check every minute on the wall clock; unref so it never blocks process /
  // test exit. Tests bypass this and call tickSchedules(now) directly.
  const schedTimer = setInterval(() => void tickSchedules(new Date()), 60_000);
  schedTimer.unref();

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
      // Reject non-embeddable / unavailable videos at add time (oEmbed 401/404).
      // null (unknown) and true both proceed — best-effort / fail-open.
      const emb = await resolveEmbeddable(url);
      if (emb === false) {
        ack({ ok: false, error: 'embed disabled' });
        return;
      }

      const track: Track = {
        id,
        url,
        title: title ?? null,
        addedBy: data.nickname ?? null,
      };
      // Preserve the track being replaced in server-only history so repeat-'all'
      // includes manually-changed tracks too.
      const before = await store.getOrCreate(room);
      const oldCur = before.state.currentTrack;
      if (oldCur) await store.setHistory(room, [...before.history, oldCur]);
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
      // Reject non-embeddable / unavailable videos at add time (oEmbed 401/404).
      // null (unknown) and true both proceed — best-effort / fail-open.
      const emb = await resolveEmbeddable(url);
      if (emb === false) {
        ack({ ok: false, error: 'embed disabled' });
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

      // If nothing is currently playing (idle player), auto-start the queue head
      // right away — adding a song to an empty player begins playback, like most
      // music apps. (When a track is already playing, enqueue just queues.)
      if (!record.state.currentTrack) {
        const after = await store.get(room);
        const q = after?.state.queue ?? [];
        if (q.length > 0) {
          const [head, ...rest] = q;
          await store.patchState(room, {
            currentTrack: head,
            queue: rest,
            isPlaying: true,
            playbackError: null,
          });
        }
      }

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
      // The Player may press "다음 곡" too. A player uses its joined room and
      // skips the controller/anonymity checks; everyone else goes through the
      // controller + anonymity gates.
      let room: string;
      if (data.role === 'player') {
        if (!data.roomCode) {
          ack({ ok: false, error: 'not in a room' });
          return;
        }
        room = data.roomCode;
      } else {
        const r = requireController(ack);
        if (!r) return;
        if (await anonymityBlocked(r, ack)) return;
        room = r;
      }
      const { reason } = payload ?? ({} as NextTrackPayload);
      if (!withinLimit(reason, LIMITS.reason)) {
        ack({ ok: false, error: 'input too long' });
        return;
      }

      const record = await store.getOrCreate(room);
      // Manual next ALWAYS advances (ignores repeat 'one'). With an empty queue
      // and no 'all' loop there is nothing to go to: ack ok, leave playback as
      // is (don't stop on a manual next — matches the prior no-op behaviour).
      if (record.state.queue.length === 0 && record.state.repeat !== 'all') {
        ack({ ok: true });
        return;
      }

      await advance(room, (detail) => recordActivity('skip', reason?.trim() || null, detail));
      ack({ ok: true });
    });

    socket.on(C2S.TrackEnded, async (_payload, ack: AckFn) => {
      const room = requirePlayer(ack);
      if (!room) return;

      const record = await store.getOrCreate(room);
      // repeat 'one': on AUTO end, replay the current track from the start.
      // No activity (avoid log noise). Handled here, not in advance().
      if (record.state.repeat === 'one' && record.state.currentTrack) {
        await store.patchState(room, { lastSeek: { seconds: 0, ts: Date.now() }, isPlaying: true });
        ack({ ok: true });
        await broadcastState(room);
        return;
      }

      // Otherwise behave like an automatic next via the shared advance logic.
      await advance(room, (detail) => recordActivity('skip', null, { auto: true, ...detail }));
      ack({ ok: true });
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
      // (would spam the log; Player throttles to ~2s). Stamp the server's view
      // of the current track id so the Player can resume the matching track and
      // ignore a stale position after a track change.
      const rec = await store.getOrCreate(room);
      const id = rec.state.currentTrack?.id ?? '';
      await store.patchState(room, { progress: { currentTime, duration, ts: Date.now(), id } });
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

      // A bad track is logged (code → Korean message) and skipped immediately:
      // promote the next track if the queue has one, otherwise stop and keep the
      // error visible so the Controller UI can surface it.
      const rec = await store.get(room);
      const failed = rec?.state.currentTrack ?? null;
      await recordActivity('error', `${playbackErrorMessage(code)} (코드 ${code})`, {
        code,
        id: failed?.id ?? null,
      });
      if (rec && rec.state.queue.length > 0) {
        // advance promotes the next track, sets isPlaying true, clears playbackError.
        await advance(room, (detail) => recordActivity('skip', null, { auto: true, ...detail }));
      } else {
        await store.patchState(room, {
          isPlaying: false,
          playbackError: { code, ts: Date.now(), id: failed?.id ?? '' },
        });
        await broadcastState(room);
      }
      ack({ ok: true });
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

    socket.on(C2S.SetRepeat, async (payload: SetRepeatPayload, ack: AckFn) => {
      const room = requireController(ack);
      if (!room) return;
      const { mode, reason } = payload ?? ({} as SetRepeatPayload);
      if (!withinLimit(reason, LIMITS.reason)) {
        ack({ ok: false, error: 'input too long' });
        return;
      }
      if (mode !== 'off' && mode !== 'one' && mode !== 'all') {
        ack({ ok: false, error: 'invalid mode' });
        return;
      }

      await store.patchState(room, { repeat: mode as RepeatMode });
      await recordActivity('mode', reason?.trim() || null, { repeat: mode });
      ack({ ok: true });
      await broadcastState(room);
    });

    socket.on(C2S.SetShuffle, async (payload: SetShufflePayload, ack: AckFn) => {
      const room = requireController(ack);
      if (!room) return;
      const { shuffle, reason } = payload ?? ({} as SetShufflePayload);
      if (!withinLimit(reason, LIMITS.reason)) {
        ack({ ok: false, error: 'input too long' });
        return;
      }
      const on = Boolean(shuffle);

      await store.patchState(room, { shuffle: on });
      await recordActivity('mode', reason?.trim() || null, { shuffle: on });
      ack({ ok: true });
      await broadcastState(room);
    });

    socket.on(C2S.SetSchedule, async (payload: SetSchedulePayload, ack: AckFn) => {
      const room = requirePlayer(ack);
      if (!room) return;
      const { schedule, reason } = payload ?? ({} as SetSchedulePayload);
      if (!withinLimit(reason, LIMITS.reason)) {
        ack({ ok: false, error: 'input too long' });
        return;
      }
      // null clears the schedule; otherwise it must be structurally valid.
      if (schedule !== null && (typeof schedule !== 'object' || !isValidSchedule(schedule))) {
        ack({ ok: false, error: 'invalid schedule' });
        return;
      }

      await store.patchState(room, { schedule });
      await recordActivity('schedule', reason?.trim() || null, {
        enabled: schedule?.enabled ?? false,
      });
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

  return { httpServer, io, tickSchedules };
}

// Auto-start unless imported (e.g. by tests).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const dataFile =
    process.env.REMOTE_DJ_DATA_FILE ?? path.resolve(process.cwd(), '.data', 'rooms.json');
  console.log(`remote-dj persisting room state to ${dataFile}`);
  const { httpServer } = createServer(new PersistentRoomStore(dataFile));
  const port = Number(process.env.PORT ?? 3001);
  const hostname = process.env.HOSTNAME ?? '0.0.0.0';
  httpServer.listen(port, hostname, () => {
    console.log(`remote-dj server listening on http://${hostname}:${port}`);
  });
}
