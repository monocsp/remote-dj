'use client';

import {
  type Ack,
  type ActivityEntry,
  C2S,
  type Role,
  type RoomSettings,
  type RoomState,
  S2C,
  type Track,
  type WeeklySchedule,
} from '@remote-dj/shared';
import { type Socket, io } from 'socket.io-client';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { getServerUrl } from './serverUrl';

// ── Store shape ──────────────────────────────────────────────────────────
interface RoomStoreState {
  state: RoomState | null;
  log: ActivityEntry[];
  connected: boolean;
  synced: boolean;
  lastError: string | null;
  mySocketId: string | null;
}

const INITIAL: RoomStoreState = {
  state: null,
  log: [],
  connected: false,
  synced: false,
  lastError: null,
  mySocketId: null,
};

const store = createStore<RoomStoreState>(() => INITIAL);

const DISCONNECTED_ACK: Ack = { ok: false, error: 'not connected' };

// Stable empty-array reference. Returning a fresh `[]` from a useSyncExternalStore
// selector triggers React's "getServerSnapshot should be cached" infinite loop.
const EMPTY_PLAYLIST: Track[] = [];

// Stable empty-object reference for the trackGain selector (see EMPTY_PLAYLIST note).
const EMPTY_GAIN: Record<string, number> = {};

// Stable empty-array reference for the blockedIds selector (see EMPTY_PLAYLIST note).
const EMPTY_IDS: string[] = [];

// ── Module-level single socket + ref counter ───────────────────────────────
let socket: Socket | null = null;
let refs = 0;

/**
 * Connect (or join the existing connection to) a room. The server is
 * authoritative; this store merely mirrors pushed state. Safe under React
 * StrictMode double-mount thanks to the ref counter — only the first ref
 * creates the socket, only the last cleanup tears it down.
 */
export function connectRoom(
  roomCode: string,
  role: Role,
  nickname?: string,
  password?: string,
): () => void {
  if (!roomCode) return () => {};

  refs += 1;

  if (!socket) {
    const s = io(getServerUrl(), { transports: ['websocket'] });
    socket = s;

    s.on('connect', () => {
      // Fires on first connect AND on every auto-reconnect → (re)join the room.
      store.setState({ connected: true, mySocketId: s.id });
      s.timeout(ACK_TIMEOUT_MS)
        .emitWithAck(C2S.Join, { roomCode, role, nickname, password })
        .then((ack: Ack) => {
          store.setState({ synced: ack.ok, lastError: ack.error ?? null });
        })
        .catch(() => store.setState({ synced: false }));
    });

    s.on('disconnect', () => {
      store.setState({ connected: false, synced: false });
    });

    s.on(S2C.State, (next: RoomState) => store.setState({ state: next }));
    s.on(S2C.ActivityLog, (entries: ActivityEntry[]) => store.setState({ log: entries }));
    s.on(S2C.Activity, (entry: ActivityEntry) =>
      store.setState((prev) => ({ log: [entry, ...prev.log] })),
    );
  }

  return () => {
    refs -= 1;
    if (refs <= 0) {
      refs = 0;
      socket?.disconnect();
      socket = null;
      store.setState(INITIAL, true);
    }
  };
}

// Max time to wait for a server ack before treating the call as failed. Without
// this, an emit issued while the socket is mid-disconnect could hang forever.
const ACK_TIMEOUT_MS = 8000;

/**
 * Safe emit: returns a graceful DISCONNECTED_ACK instead of throwing/rejecting
 * when the socket is absent or not currently connected (e.g. during a server
 * reload / reconnect). socket.io auto-reconnects; calls in the gap just no-op.
 * The timeout + catch prevent the "socket has been disconnected" overlay and
 * any unhandled rejection from fire-and-forget callers (progress/playbackError).
 */
function call(event: string, payload: unknown): Promise<Ack> {
  const s = socket;
  if (!s || !s.connected) return Promise.resolve(DISCONNECTED_ACK);
  return s
    .timeout(ACK_TIMEOUT_MS)
    .emitWithAck(event, payload)
    .then((ack) => ack as Ack)
    .catch(() => DISCONNECTED_ACK);
}

// ── Actions (stable module-level identity) ──────────────────────────────────
export const actions = {
  changeTrack: (url: string, reason: string, title?: string): Promise<Ack> =>
    call(C2S.ChangeTrack, { url, reason, title }),
  setVolume: (volume: number, reason?: string): Promise<Ack> =>
    call(C2S.SetVolume, { volume, reason }),
  togglePlay: (isPlaying: boolean, reason?: string): Promise<Ack> =>
    call(C2S.TogglePlay, { isPlaying, reason }),
  updateSettings: (settings: Partial<RoomSettings>, reason?: string): Promise<Ack> =>
    call(C2S.UpdateSettings, { settings, reason }),
  enqueueTrack: (url: string, reason?: string, title?: string): Promise<Ack> =>
    call(C2S.EnqueueTrack, { url, reason, title }),
  removeQueued: (index: number, reason?: string): Promise<Ack> =>
    call(C2S.RemoveQueued, { index, reason }),
  // Jump the cursor to an existing playlist index and play it (player/main only).
  jumpTo: (index: number, reason?: string): Promise<Ack> => call(C2S.JumpTo, { index, reason }),
  nextTrack: (reason?: string): Promise<Ack> => call(C2S.NextTrack, { reason }),
  trackEnded: (): Promise<Ack> => call(C2S.TrackEnded, {}),
  seekTo: (seconds: number, reason?: string): Promise<Ack> => call(C2S.SeekTo, { seconds, reason }),
  progress: (currentTime: number, duration: number): Promise<Ack> =>
    call(C2S.Progress, { currentTime, duration }),
  playbackError: (code: number, id?: string): Promise<Ack> => call(C2S.PlaybackError, { code, id }),
  setTrackGain: (videoId: string, gain: number, reason?: string): Promise<Ack> =>
    call(C2S.SetTrackGain, { videoId, gain, reason }),
  setRepeat: (mode: RoomState['repeat'], reason?: string): Promise<Ack> =>
    call(C2S.SetRepeat, { mode, reason }),
  setSchedule: (schedule: WeeklySchedule | null, reason?: string): Promise<Ack> =>
    call(C2S.SetSchedule, { schedule, reason }),
  // One-shot shuffle of the upcoming items (player/main only).
  shuffleQueue: (reason?: string): Promise<Ack> => call(C2S.ShuffleQueue, { reason }),
} as const;

// ── Fine-grained selector hooks ──────────────────────────────────────────────
export const useConnected = () => useStore(store, (s) => s.connected);
export const useSynced = () => useStore(store, (s) => s.synced);
export const useRoomState = () => useStore(store, (s) => s.state);
// The ordered playlist + cursor. Current track is derived (playlist[currentIndex]).
export const usePlaylist = () => useStore(store, (s) => s.state?.playlist ?? EMPTY_PLAYLIST);
export const useCurrentIndex = () => useStore(store, (s) => s.state?.currentIndex ?? -1);
// videoIds the server marked unplayable (embed-disabled) in this room.
export const useBlockedIds = () => useStore(store, (s) => s.state?.blockedIds ?? EMPTY_IDS);
export const useCurrentTrack = () =>
  useStore(store, (s) => {
    const st = s.state;
    if (!st) return null;
    const i = st.currentIndex;
    return i >= 0 && i < st.playlist.length ? st.playlist[i] : null;
  });
export const useIsPlaying = () => useStore(store, (s) => s.state?.isPlaying ?? false);
export const useVolume = () => useStore(store, (s) => s.state?.volume ?? 100);
export const useRepeat = () => useStore(store, (s) => s.state?.repeat ?? 'off');
// Stable ref (EMPTY_GAIN) so the empty case doesn't churn useSyncExternalStore.
export const useTrackGain = () => useStore(store, (s) => s.state?.trackGain ?? EMPTY_GAIN);
// Returns the stored nullable object reference directly — stable until the
// server pushes a new RoomState — so it's safe for useSyncExternalStore.
export const useSettings = () => useStore(store, (s) => s.state?.settings ?? null);
export const useSchedule = () => useStore(store, (s) => s.state?.schedule ?? null);
export const useProgress = () => useStore(store, (s) => s.state?.progress ?? null);
export const useLastSeek = () => useStore(store, (s) => s.state?.lastSeek ?? null);
export const usePlaybackError = () => useStore(store, (s) => s.state?.playbackError ?? null);
export const useActivityLog = () => useStore(store, (s) => s.log);
export const useLastError = () => useStore(store, (s) => s.lastError);
export const useMySocketId = () => useStore(store, (s) => s.mySocketId);
