// @remote-dj/shared — single-file protocol contract.
// No internal relative imports: avoids NodeNext `.js` extension requirements.
// Source of truth for events/types/utils shared by server and web.

// ── Roles ────────────────────────────────────────────────────────────────
export type Role = 'player' | 'controller';

// ── Playback modes ─────────────────────────────────────────────────────────
// off  — when the queue empties, stop (keep currentTrack).
// one  — on AUTO track end, replay the current track (manual next ignores this).
// all  — when the queue empties, loop back through everything already played.
export type RepeatMode = 'off' | 'one' | 'all';

// ── Domain types ───────────────────────────────────────────────────────────
export interface Track {
  id: string; // YouTube video id
  url: string;
  title: string | null;
  addedBy: string | null; // null = anonymous
}

export interface RoomSettings {
  allowAnonymous: boolean;
}

export interface RoomState {
  roomCode: string;
  currentTrack: Track | null;
  queue: Track[]; // upcoming tracks, played in order after currentTrack
  isPlaying: boolean;
  volume: number; // 0-100
  repeat: RepeatMode; // 'off' (default) | 'one' | 'all'
  shuffle: boolean; // when true, advance picks a random track instead of the head
  settings: RoomSettings;
  presence: { playerConnected: boolean; controllers: number };
  updatedAt: number; // epoch ms
  stateVersion: number; // monotonic counter, bumped on every patch; lets clients detect/resync missed updates
  // Latest player-reported playback position; null until the first progress report.
  // `id` is the videoId this position belongs to (lets the Player resume the
  // matching track and ignore a stale position after a track change).
  progress: { currentTime: number; duration: number; ts: number; id: string } | null;
  // Latest seek command the Player should apply; null initially.
  lastSeek: { seconds: number; ts: number } | null;
  // Latest player-reported playback error; null when none / cleared on a new track.
  playbackError: { code: number; ts: number } | null;
  // Per-track loudness-normalization gain: videoId → attenuation factor in
  // [0.2, 1.0]. Absent ⇒ 1.0 (no change). We can only ATTENUATE (YouTube
  // setVolume maxes at 100), so gain is always ≤ 1. Shared across the room.
  trackGain: Record<string, number>;
}

export type ActivityType =
  | 'track_change'
  | 'volume'
  | 'play'
  | 'pause'
  | 'settings'
  | 'enqueue'
  | 'dequeue'
  | 'skip'
  | 'seek'
  | 'gain'
  | 'mode';

export interface ActivityEntry {
  id: string;
  ts: number; // epoch ms
  actor: string | null; // null = anonymous
  type: ActivityType;
  reason: string | null;
  detail?: Record<string, unknown>;
}

// ── Payload types ──────────────────────────────────────────────────────────
export interface JoinPayload {
  roomCode: string;
  role: Role;
  nickname?: string;
  password?: string;
}

export interface ChangeTrackPayload {
  url: string;
  reason: string;
  title?: string;
}

export interface SetVolumePayload {
  volume: number;
  reason?: string;
}

export interface TogglePlayPayload {
  isPlaying: boolean;
  reason?: string;
}

export interface UpdateSettingsPayload {
  settings: Partial<RoomSettings>;
  reason?: string;
}

export interface EnqueueTrackPayload {
  url: string;
  reason?: string; // optional — unlike changeTrack, enqueue reason is not required
  title?: string;
}

export interface RemoveQueuedPayload {
  index: number; // index into RoomState.queue
  reason?: string;
}

export interface NextTrackPayload {
  reason?: string; // optional
}

// Player status report: the current track finished playing. No fields.
export type TrackEndedPayload = Record<string, never>;

// Controller asks the Player to seek to an absolute position (seconds).
export interface SeekToPayload {
  seconds: number;
  reason?: string;
}

// Player reports its current playback position. High-frequency; NOT logged.
export interface ProgressPayload {
  currentTime: number;
  duration: number;
}

// Player reports a YouTube playback error (IFrame API error code). Player-only.
export interface PlaybackErrorPayload {
  code: number;
}

// Controller sets the per-track loudness-normalization gain (attenuation only).
export interface SetTrackGainPayload {
  videoId: string;
  gain: number; // clamped to [0.2, 1.0]
  reason?: string;
}

// Controller sets the repeat mode.
export interface SetRepeatPayload {
  mode: RepeatMode;
  reason?: string;
}

// Controller toggles shuffle.
export interface SetShufflePayload {
  shuffle: boolean;
  reason?: string;
}

export interface Ack {
  ok: boolean;
  error?: string;
}

// ── Event name constants ─────────────────────────────────────────────────
export const C2S = {
  Join: 'join',
  ChangeTrack: 'changeTrack',
  SetVolume: 'setVolume',
  TogglePlay: 'togglePlay',
  UpdateSettings: 'updateSettings',
  EnqueueTrack: 'enqueueTrack',
  RemoveQueued: 'removeQueued',
  NextTrack: 'nextTrack',
  TrackEnded: 'trackEnded',
  SeekTo: 'seekTo',
  Progress: 'progress',
  PlaybackError: 'playbackError',
  SetTrackGain: 'setTrackGain',
  SetRepeat: 'setRepeat',
  SetShuffle: 'setShuffle',
} as const;

export const S2C = {
  State: 'state',
  Activity: 'activity',
  ActivityLog: 'activityLog',
} as const;

// ── Utils ──────────────────────────────────────────────────────────────────

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Extract an 11-char YouTube video id from the various URL forms:
 * youtu.be/<id>, youtube.com/watch?v=<id>, youtube.com/embed/<id>,
 * youtube.com/shorts/<id>, music.youtube.com, with/without query params.
 * Returns null when no valid id is found.
 */
export function parseYouTubeId(url: string): string | null {
  if (typeof url !== 'string' || url.trim() === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }

  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();

  // youtu.be/<id>
  if (host === 'youtu.be') {
    const id = parsed.pathname.slice(1).split('/')[0];
    return YOUTUBE_ID.test(id) ? id : null;
  }

  const isYouTubeHost =
    host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com';
  if (!isYouTubeHost) return null;

  // watch?v=<id>
  const v = parsed.searchParams.get('v');
  if (v && YOUTUBE_ID.test(v)) return v;

  // /embed/<id> and /shorts/<id>
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length >= 2 && (segments[0] === 'embed' || segments[0] === 'shorts')) {
    const id = segments[1];
    return YOUTUBE_ID.test(id) ? id : null;
  }

  return null;
}

/** True if `r` is non-empty after trimming. */
export function validateReason(r: string): boolean {
  return r.trim().length > 0;
}

/** Round then clamp to [0, 100]. */
export function clampVolume(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * Round to 2 decimals then clamp to [0.2, 1.0]. Loudness gain is
 * attenuate-only (≤ 1) since YouTube setVolume tops out at 100.
 */
export function clampGain(g: number): number {
  return Math.max(0.2, Math.min(1.0, Math.round(g * 100) / 100));
}

/** Max accepted lengths for free-form string inputs (chars). */
export const LIMITS = { reason: 500, url: 2048, nickname: 40, title: 200, password: 64 } as const;

/** True if `s` is null/undefined or no longer than `max` chars. */
export function withinLimit(s: string | undefined, max: number): boolean {
  return s == null || s.length <= max;
}

const ROOM_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Generate a 6-char room code from the confusion-free charset. */
export function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += ROOM_CODE_CHARSET[Math.floor(Math.random() * ROOM_CODE_CHARSET.length)];
  }
  return code;
}
