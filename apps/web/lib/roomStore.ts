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
}

const INITIAL: RoomStoreState = {
  state: null,
  log: [],
  connected: false,
  synced: false,
  lastError: null,
};

const store = createStore<RoomStoreState>(() => INITIAL);

const DISCONNECTED_ACK: Ack = { ok: false, error: 'not connected' };

// Stable empty-array reference. Returning a fresh `[]` from a useSyncExternalStore
// selector triggers React's "getServerSnapshot should be cached" infinite loop.
const EMPTY_QUEUE: Track[] = [];

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
      store.setState({ connected: true });
      s.emitWithAck(C2S.Join, { roomCode, role, nickname, password }).then((ack: Ack) => {
        store.setState({ synced: ack.ok, lastError: ack.error ?? null });
      });
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

// ── Actions (stable module-level identity) ──────────────────────────────────
export const actions = {
  changeTrack(url: string, reason: string, title?: string): Promise<Ack> {
    if (!socket) return Promise.resolve(DISCONNECTED_ACK);
    return socket.emitWithAck(C2S.ChangeTrack, { url, reason, title });
  },
  setVolume(volume: number, reason?: string): Promise<Ack> {
    if (!socket) return Promise.resolve(DISCONNECTED_ACK);
    return socket.emitWithAck(C2S.SetVolume, { volume, reason });
  },
  togglePlay(isPlaying: boolean, reason?: string): Promise<Ack> {
    if (!socket) return Promise.resolve(DISCONNECTED_ACK);
    return socket.emitWithAck(C2S.TogglePlay, { isPlaying, reason });
  },
  updateSettings(settings: Partial<RoomSettings>, reason?: string): Promise<Ack> {
    if (!socket) return Promise.resolve(DISCONNECTED_ACK);
    return socket.emitWithAck(C2S.UpdateSettings, { settings, reason });
  },
  enqueueTrack(url: string, reason?: string, title?: string): Promise<Ack> {
    if (!socket) return Promise.resolve(DISCONNECTED_ACK);
    return socket.emitWithAck(C2S.EnqueueTrack, { url, reason, title });
  },
  removeQueued(index: number, reason?: string): Promise<Ack> {
    if (!socket) return Promise.resolve(DISCONNECTED_ACK);
    return socket.emitWithAck(C2S.RemoveQueued, { index, reason });
  },
  nextTrack(reason?: string): Promise<Ack> {
    if (!socket) return Promise.resolve(DISCONNECTED_ACK);
    return socket.emitWithAck(C2S.NextTrack, { reason });
  },
  trackEnded(): Promise<Ack> {
    if (!socket) return Promise.resolve(DISCONNECTED_ACK);
    return socket.emitWithAck(C2S.TrackEnded, {});
  },
  seekTo(seconds: number, reason?: string): Promise<Ack> {
    if (!socket) return Promise.resolve(DISCONNECTED_ACK);
    return socket.emitWithAck(C2S.SeekTo, { seconds, reason });
  },
  progress(currentTime: number, duration: number): Promise<Ack> {
    if (!socket) return Promise.resolve(DISCONNECTED_ACK);
    return socket.emitWithAck(C2S.Progress, { currentTime, duration });
  },
} as const;

// ── Fine-grained selector hooks ──────────────────────────────────────────────
export const useConnected = () => useStore(store, (s) => s.connected);
export const useSynced = () => useStore(store, (s) => s.synced);
export const useRoomState = () => useStore(store, (s) => s.state);
export const useCurrentTrack = () => useStore(store, (s) => s.state?.currentTrack ?? null);
export const useIsPlaying = () => useStore(store, (s) => s.state?.isPlaying ?? false);
export const useVolume = () => useStore(store, (s) => s.state?.volume ?? 100);
export const useQueue = () => useStore(store, (s) => s.state?.queue ?? EMPTY_QUEUE);
// Returns the stored nullable object reference directly — stable until the
// server pushes a new RoomState — so it's safe for useSyncExternalStore.
export const useSettings = () => useStore(store, (s) => s.state?.settings ?? null);
export const useProgress = () => useStore(store, (s) => s.state?.progress ?? null);
export const useLastSeek = () => useStore(store, (s) => s.state?.lastSeek ?? null);
export const useActivityLog = () => useStore(store, (s) => s.log);
export const useLastError = () => useStore(store, (s) => s.lastError);
