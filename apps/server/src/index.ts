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
  type JumpToPayload,
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
  type SetTrackGainPayload,
  type SetVolumePayload,
  type ShuffleQueuePayload,
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
 * Check whether a YouTube URL is embeddable / available at add time
 * (changeTrack/enqueueTrack). Never throws. Returns:
 *  - true  → embeddable, proceed.
 *  - false → embedding disabled / video unavailable, reject ('embed disabled').
 *  - null  → UNKNOWN → fail open, proceed.
 *
 * DEFINITIVE path: if YOUTUBE_API_KEY is set, the YouTube Data API
 * (videos.list?part=status) reports `status.embeddable` reliably — this is the
 * ONLY keyless-free way to catch embed-disabled on the FIRST add. Without a key
 * we fall back to oEmbed (catches deleted/private = 401/404 only; embed-disabled
 * returns 200, so those are caught later at playback + then blocked per-room).
 * When REMOTE_DJ_FAKE_TITLE is set, returns true without any network access.
 */
export async function defaultResolveEmbeddable(url: string): Promise<boolean | null> {
  // RETURN CONTRACT:
  //   true  → AUTHORITATIVELY embeddable (Data API status.embeddable). The caller
  //           treats this as ground truth and will UN-block a previously-blocked
  //           video (self-heal when an owner re-enables embedding).
  //   false → authoritatively NOT embeddable / unavailable → reject at add time.
  //   null  → UNKNOWN (oEmbed 200, no key, network error, test mode) → fail-open,
  //           but respect the learned per-room blocklist.
  // oEmbed returns 200 for embed-disabled videos, so it can NEVER assert true.
  if (process.env.REMOTE_DJ_FAKE_TITLE) return null;

  const apiKey = process.env.YOUTUBE_API_KEY;
  const id = parseYouTubeId(url);
  if (apiKey && id) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBEDDABLE_FETCH_TIMEOUT_MS);
    try {
      const api = `https://www.googleapis.com/youtube/v3/videos?part=status&id=${id}&key=${apiKey}`;
      const res = await fetch(api, { signal: controller.signal });
      if (res.ok) {
        const data = (await res.json()) as {
          items?: { status?: { embeddable?: boolean } }[];
        };
        const item = data.items?.[0];
        if (!item) return false; // no such video (deleted/private) → reject
        if (item.status?.embeddable === false) return false; // embed disabled → reject
        if (item.status?.embeddable === true) return true; // authoritative OK
      }
      // Non-ok (quota 403 / invalid key 400) / unexpected → fall through to oEmbed.
    } catch {
      // ignore → fall through to oEmbed
    } finally {
      clearTimeout(timer);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBEDDABLE_FETCH_TIMEOUT_MS);
  try {
    const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetch(oembed, { signal: controller.signal });
    if (res.status === 401 || res.status === 404) return false; // deleted/private
    return null; // 200 (can't confirm embeddability) or other → unknown
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decide whether to reject an add, from the embeddable result + the room's
 * blocklist:
 *  - emb === false → reject. Data API status.embeddable=false (owner disabled
 *    embedding) — caught at the FIRST add.
 *  - already blocked → reject, regardless of `emb`. A 150/101 at playback is
 *    GROUND TRUTH that the video won't play in our embed, so the block is
 *    STICKY. We deliberately do NOT auto-unblock on a `true` Data API result:
 *    licensed-music videos report status.embeddable=TRUE yet still fail with 150,
 *    so trusting `true` would re-add → re-fail forever. The block clears only
 *    when the room is recreated (blockedIds lives in room state).
 *  - otherwise (true/null and not blocked) → allow.
 */
export function decideEmbed(
  emb: boolean | null,
  blockedIds: string[],
  id: string,
): { reject: boolean; blockedIds: string[] } {
  if (emb === false) return { reject: true, blockedIds };
  if (blockedIds.includes(id)) return { reject: true, blockedIds };
  return { reject: false, blockedIds };
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

  // videoIds known to be NON-EMBEDDABLE (YouTube error 101/150) live in
  // RoomState.blockedIds (per room) so clients can MARK them in the list and the
  // server can skip them. There's no reliable keyless way to detect embed-disabled
  // at add time, so we learn from the Player's playback errors; decideEmbed()
  // (module scope) folds the blocklist + embeddable result into an add decision.

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
   * matching playlist items that still lack a title, then re-broadcast.
   * Fire-and-forget from the handlers so the original ack/broadcast is never
   * delayed. Never throws.
   */
  async function enrichTitle(roomCode: string, url: string, id: string): Promise<void> {
    const title = await resolveTitle(url);
    if (!title) return;
    const rec = await store.get(roomCode);
    if (!rec) return;

    let changed = false;
    const playlist = rec.state.playlist.map((t) => {
      if (t.id === id && !t.title) {
        changed = true;
        return { ...t, title };
      }
      return t;
    });

    if (changed) await store.patchState(roomCode, { playlist });
    // Backfill activity-log entries stamped before the title resolved (e.g.
    // enqueue logs `title:null`) so the Activity Log shows the real title too,
    // instead of "(제목 없음)". Goes through the store so persistence sees it.
    const logChanged = await store.backfillActivityTitle(roomCode, id, title);
    if (changed || logChanged) await broadcastState(roomCode);
    // Re-send the full log so clients replace the stale (title-less) entries.
    if (logChanged) {
      const fresh = await store.get(roomCode);
      if (fresh) io.to(roomCode).emit(S2C.ActivityLog, fresh.log);
    }
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
   * (player trackEnded). Moves the cursor forward in the single playlist,
   * SKIPPING any track known to be embed-disabled (per-room blocklist) so a
   * blocked track is never selected as current. The repeat-'one' replay is
   * handled by the trackEnded caller, never here.
   *
   *  - scans forward to the next PLAYABLE (non-blocked) track.
   *  - past the end + (repeat 'all' or opts.allowWrap): wrap to the start and
   *    keep scanning.
   *  - past the end + 'off'/'one': stop (isPlaying:false), keep the cursor.
   *  - nothing playable anywhere (empty, or every remaining/looped track
   *    blocked): stop. This is the loop backstop — even under repeat 'all' an
   *    all-blocked list stops instead of spinning.
   *
   * `log` records the resulting activity (skip) — auto end passes a null actor
   * with detail {auto:true}; manual next passes the controller's reason.
   */
  async function advance(
    roomCode: string,
    log: (detail: Record<string, unknown>) => Promise<void>,
    opts?: { allowWrap?: boolean },
  ): Promise<void> {
    const record = await store.getOrCreate(roomCode);
    const { playlist, currentIndex, repeat } = record.state;

    if (playlist.length === 0) {
      await store.patchState(roomCode, { isPlaying: false, currentIndex: -1 });
      await broadcastState(roomCode);
      return;
    }

    const canWrap = opts?.allowWrap ?? repeat === 'all';
    const blocked = new Set(record.state.blockedIds);
    // Scan forward at most playlist.length candidates → finds the next playable
    // track, wrapping if allowed, and is bounded so an all-blocked list stops.
    let next = currentIndex;
    for (let step = 0; step < playlist.length; step++) {
      next += 1;
      if (next >= playlist.length) {
        if (!canWrap) break; // reached the end, no wrap → stop below
        next = 0;
      }
      if (!blocked?.has(playlist[next].id)) {
        await store.patchState(roomCode, {
          currentIndex: next,
          isPlaying: true,
          playbackError: null,
        });
        await log({ id: playlist[next].id, title: playlist[next].title });
        await broadcastState(roomCode);
        return;
      }
      // blocked → keep scanning to the following candidate
    }

    // Nothing playable (end reached with no wrap, or every track blocked): stop,
    // keep the cursor where it is. `playbackError` is left as-is so a banner set
    // by the caller (playbackError handler) persists.
    await store.patchState(roomCode, { isPlaying: false });
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
      if (want === null) {
        // No/disabled schedule → forget the last edge so re-enabling within the
        // same window still fires a fresh edge.
        lastWant.delete(code);
        continue;
      }

      const prev = lastWant.get(code);
      lastWant.set(code, want);
      if (want === prev) continue; // act only on the EDGE

      if (want === true && !rec.state.isPlaying) {
        // Start playback: resume the current cursor, else start the playlist
        // head. With NOTHING to play (empty playlist) we do nothing — never set
        // isPlaying:true with currentIndex -1 (that would be an inconsistent state).
        if (rec.state.currentIndex >= 0) {
          await store.patchState(code, { isPlaying: true });
        } else if (rec.state.playlist.length > 0) {
          await store.patchState(code, {
            currentIndex: 0,
            isPlaying: true,
            playbackError: null,
          });
        } else {
          continue; // empty playlist — nothing to start
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
      // Attribute the MAIN device's actions to "Player" (or "Player(닉네임)" when
      // it has a nickname) instead of "익명". Controllers keep nickname-or-null.
      const actor =
        data.role === 'player'
          ? data.nickname
            ? `Player(${data.nickname})`
            : 'Player'
          : (data.nickname ?? null);
      const entry: ActivityEntry = {
        id: nanoid(8),
        ts: Date.now(),
        actor,
        type,
        reason,
        detail,
      };
      await store.appendActivity(roomCode, entry);
      io.to(roomCode).emit(S2C.Activity, entry);
    }

    /**
     * Guard: any room MEMBER (controller OR player) may emit guest-allowed
     * control events (changeTrack/enqueueTrack/setVolume/togglePlay/setTrackGain).
     */
    function requireMember(ack: AckFn): string | null {
      if (data.role !== 'controller' && data.role !== 'player') {
        ack({ ok: false, error: 'not in a room' });
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
     * Anonymity gate for CONTROLLER content actions (changeTrack/enqueueTrack).
     * When a room has settings.allowAnonymous === false and this socket has no
     * nickname, ack { ok:false, error:'nickname required' } and return true.
     * Applied ONLY to controllers (guests) — the player is the MAIN and is never
     * gated. NOT applied to setVolume/togglePlay/setTrackGain — that keeps
     * low-stakes controls open and (critically) updateSettings is player-only
     * so the room can never lock itself out.
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
      const room = requireMember(ack);
      if (!room) return;
      if (data.role === 'controller' && (await anonymityBlocked(room, ack))) return;
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
      const emb = await resolveEmbeddable(url);
      const before = await store.getOrCreate(room);
      const blockDecision = decideEmbed(emb, before.state.blockedIds, id);
      if (blockDecision.reject) {
        ack({ ok: false, error: 'embed disabled' });
        return;
      }

      const track: Track = {
        id,
        url,
        title: title ?? null,
        addedBy: data.nickname ?? null,
        addedAt: Date.now(),
        ownerId: socket.id,
      };
      // Append the new track to the playlist and jump the cursor to it.
      const playlist = [...before.state.playlist, track];
      await store.patchState(room, {
        playlist,
        currentIndex: playlist.length - 1,
        isPlaying: true,
        playbackError: null,
        blockedIds: blockDecision.blockedIds,
      });
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
      const room = requireMember(ack);
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
      const room = requireMember(ack);
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
      const room = requirePlayer(ack);
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
      const room = requireMember(ack);
      if (!room) return;
      if (data.role === 'controller' && (await anonymityBlocked(room, ack))) return;
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
      const emb = await resolveEmbeddable(url);
      const record = await store.getOrCreate(room);
      const blockDecision = decideEmbed(emb, record.state.blockedIds, id);
      if (blockDecision.reject) {
        ack({ ok: false, error: 'embed disabled' });
        return;
      }

      const track: Track = {
        id,
        url,
        title: title ?? null,
        addedBy: data.nickname ?? null,
        addedAt: Date.now(),
        ownerId: socket.id,
      };
      const playlist = [...record.state.playlist, track];
      // Idle player (nothing has started, currentIndex < 0): adding a song begins
      // playback at the new (only) track. Otherwise just append to the playlist.
      if (record.state.currentIndex < 0) {
        await store.patchState(room, {
          playlist,
          currentIndex: playlist.length - 1,
          isPlaying: true,
          playbackError: null,
          blockedIds: blockDecision.blockedIds,
        });
      } else {
        await store.patchState(room, { playlist, blockedIds: blockDecision.blockedIds });
      }
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
      // Remove a track from the playlist by index. Member (Player OR Controller)
      // may remove, then OWNERSHIP is enforced: the Player (main) may remove ANY
      // item; a Controller may remove only the items it added (ownerId/nickname).
      const room = requireMember(ack);
      if (!room) return;
      const { index, reason } = payload ?? ({} as RemoveQueuedPayload);
      if (!withinLimit(reason, LIMITS.reason)) {
        ack({ ok: false, error: 'input too long' });
        return;
      }

      const record = await store.getOrCreate(room);
      const playlist = record.state.playlist;
      if (!Number.isInteger(index) || index < 0 || index >= playlist.length) {
        ack({ ok: false, error: 'invalid index' });
        return;
      }

      const item = playlist[index];
      const allowed =
        data.role === 'player' ||
        item.ownerId === socket.id ||
        (data.nickname != null && item.addedBy === data.nickname);
      if (!allowed) {
        ack({ ok: false, error: 'not your item' });
        return;
      }

      const next = [...playlist.slice(0, index), ...playlist.slice(index + 1)];
      // Adjust the cursor so it keeps pointing at the right track.
      const curIdx = record.state.currentIndex;
      const patch: Partial<RoomState> = { playlist: next };
      if (next.length === 0) {
        patch.currentIndex = -1;
        patch.isPlaying = false;
      } else if (index < curIdx) {
        // A track before the current one was removed → shift the cursor left.
        patch.currentIndex = curIdx - 1;
      } else if (index === curIdx) {
        // The CURRENT track was removed: the next track slides into this index
        // and becomes current. Clamp to the new last index if we were at the end.
        patch.currentIndex = Math.min(curIdx, next.length - 1);
        patch.playbackError = null;
      }
      // index > curIdx (an upcoming item) → cursor unchanged.
      await store.patchState(room, patch);
      await recordActivity('dequeue', reason?.trim() || null, {
        index,
        id: item.id,
        title: item.title,
      });
      ack({ ok: true });
      await broadcastState(room);
    });

    socket.on(C2S.JumpTo, async (payload: JumpToPayload, ack: AckFn) => {
      // Tap a row to play that track now — an instant cursor jump. MAIN only
      // (an instant track change, which limited guests are not allowed to do).
      const room = requirePlayer(ack);
      if (!room) return;
      const { index, reason } = payload ?? ({} as JumpToPayload);
      if (!withinLimit(reason, LIMITS.reason)) {
        ack({ ok: false, error: 'input too long' });
        return;
      }
      const record = await store.getOrCreate(room);
      if (!Number.isInteger(index) || index < 0 || index >= record.state.playlist.length) {
        ack({ ok: false, error: 'invalid index' });
        return;
      }
      const t = record.state.playlist[index];
      await store.patchState(room, {
        currentIndex: index,
        isPlaying: true,
        playbackError: null,
      });
      await recordActivity('track_change', reason?.trim() || null, {
        id: t.id,
        url: t.url,
        title: t.title,
      });
      ack({ ok: true });
      await broadcastState(room);
    });

    socket.on(C2S.NextTrack, async (payload: NextTrackPayload, ack: AckFn) => {
      // "다음 곡" is a MAIN action: player-only (controllers are limited guests).
      const room = requirePlayer(ack);
      if (!room) return;
      const { reason } = payload ?? ({} as NextTrackPayload);
      if (!withinLimit(reason, LIMITS.reason)) {
        ack({ ok: false, error: 'input too long' });
        return;
      }

      const record = await store.getOrCreate(room);
      // Manual next ALWAYS advances (ignores repeat 'one'). If the cursor is at
      // the end and there's no 'all' loop there is nothing forward: ack ok,
      // leave playback as is (don't stop on a manual next — prior behaviour).
      const { playlist, currentIndex, repeat } = record.state;
      if (currentIndex + 1 >= playlist.length && repeat !== 'all') {
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
      if (record.state.repeat === 'one' && record.state.currentIndex >= 0) {
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
      const room = requirePlayer(ack);
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
      const cur = rec.state.currentIndex;
      const id = cur >= 0 ? (rec.state.playlist[cur]?.id ?? '') : '';
      await store.patchState(room, { progress: { currentTime, duration, ts: Date.now(), id } });
      ack({ ok: true });
      await broadcastState(room);
    });

    socket.on(C2S.PlaybackError, async (payload: PlaybackErrorPayload, ack: AckFn) => {
      const room = requirePlayer(ack);
      if (!room) return;
      const { code, id: failedId } = payload ?? ({} as PlaybackErrorPayload);
      if (typeof code !== 'number' || !Number.isFinite(code)) {
        ack({ ok: false, error: 'invalid code' });
        return;
      }

      const rec = await store.get(room);
      const cur = rec?.state.currentIndex ?? -1;
      const failed = rec && cur >= 0 ? (rec.state.playlist[cur] ?? null) : null;
      // Ignore a STALE error: if the Player named a failed videoId and it no
      // longer matches the current track (a jump/change raced ahead), drop it so
      // we don't skip the wrong song.
      if (typeof failedId === 'string' && failedId !== '' && failed && failed.id !== failedId) {
        ack({ ok: true });
        return;
      }
      // Embed-disabled (101/150) is a permanent property of the video → remember
      // it (per room) so advance() skips it from now on, and future adds of this
      // id are blocked at the controller.
      const isEmbed = code === 101 || code === 150;
      const failedVideoId = failed?.id ?? (typeof failedId === 'string' ? failedId : '');
      await recordActivity('error', `${playbackErrorMessage(code)} (코드 ${code})`, {
        code,
        id: failed?.id ?? null,
      });
      // Embed errors → add the videoId to the room blocklist so it shows as
      // "재생 불가" in the list (persistently visible — the banner alone would
      // vanish on auto-skip) and advance() skips it from now on.
      const prevBlocked = rec?.state.blockedIds ?? [];
      const blockedIds =
        isEmbed && failedVideoId && !prevBlocked.includes(failedVideoId)
          ? [...prevBlocked, failedVideoId]
          : prevBlocked;
      // Mark the error on state; advance() will CLEAR playbackError if it lands on
      // a playable track, or LEAVE it (banner persists) if everything stops.
      await store.patchState(room, {
        playbackError: { code, ts: Date.now(), id: failed?.id ?? '' },
        blockedIds,
      });
      // Embed errors: the now-blocked track is skipped, so allow the normal
      // repeat-'all' wrap. Non-embed (transient) errors: don't wrap → stop at the
      // end instead of risking a retry storm.
      await advance(room, (detail) => recordActivity('skip', null, { auto: true, ...detail }), {
        allowWrap: isEmbed ? undefined : false,
      });
      ack({ ok: true });
    });

    socket.on(C2S.SetTrackGain, async (payload: SetTrackGainPayload, ack: AckFn) => {
      const room = requireMember(ack);
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
      const room = requirePlayer(ack);
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

    socket.on(C2S.ShuffleQueue, async (payload: ShuffleQueuePayload, ack: AckFn) => {
      // One-shot shuffle of the UPCOMING items only (those AFTER currentIndex);
      // the current + already-played items stay put. Player(main) only.
      const room = requirePlayer(ack);
      if (!room) return;
      const { reason } = payload ?? ({} as ShuffleQueuePayload);
      if (!withinLimit(reason, LIMITS.reason)) {
        ack({ ok: false, error: 'input too long' });
        return;
      }

      const record = await store.getOrCreate(room);
      const { playlist, currentIndex } = record.state;
      const head = playlist.slice(0, currentIndex + 1); // played + current
      const tail = playlist.slice(currentIndex + 1); // upcoming
      // Nothing meaningful to do for 0/1 upcoming items — ack ok, no-op.
      if (tail.length < 2) {
        ack({ ok: true });
        return;
      }

      await store.patchState(room, { playlist: [...head, ...shuffledCopy(tail)] });
      await recordActivity('mode', reason?.trim() || null, { shuffledQueue: true });
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
          lastWant.delete(room); // forget schedule edge so a recreated room starts fresh
          void store.deleteRoom(room); // blockedIds live in state → dropped with the room
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
  // Load apps/server/.env (gitignored) if present — for local config / secrets
  // like YOUTUBE_API_KEY. Never throws when the file is absent. Tests import
  // this module (not isMain), so they are unaffected.
  try {
    process.loadEnvFile(path.resolve(process.cwd(), '.env'));
  } catch {
    // no .env file → use the real environment / defaults
  }
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
