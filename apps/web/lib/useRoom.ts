'use client';

import {
  type Ack,
  type ActivityEntry,
  C2S,
  type Role,
  type RoomSettings,
  type RoomState,
  S2C,
} from '@remote-dj/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Socket, io } from 'socket.io-client';
import { getServerUrl } from './serverUrl';

export interface UseRoom {
  state: RoomState | null;
  log: ActivityEntry[];
  connected: boolean;
  changeTrack: (url: string, reason: string, title?: string) => Promise<Ack>;
  setVolume: (volume: number, reason?: string) => Promise<Ack>;
  togglePlay: (isPlaying: boolean, reason?: string) => Promise<Ack>;
  updateSettings: (settings: Partial<RoomSettings>, reason?: string) => Promise<Ack>;
}

const DISCONNECTED_ACK: Ack = { ok: false, error: 'not connected' };

export function useRoom(roomCode: string, role: Role, nickname?: string): UseRoom {
  const [state, setState] = useState<RoomState | null>(null);
  const [log, setLog] = useState<ActivityEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!roomCode) return;

    const socket = io(getServerUrl(), { transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit(C2S.Join, { roomCode, role, nickname });
      setConnected(true);
    });
    socket.on('disconnect', () => setConnected(false));

    socket.on(S2C.State, (next: RoomState) => setState(next));
    socket.on(S2C.ActivityLog, (entries: ActivityEntry[]) => setLog(entries));
    socket.on(S2C.Activity, (entry: ActivityEntry) => setLog((prev) => [entry, ...prev]));

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [roomCode, role, nickname]);

  const changeTrack = useCallback((url: string, reason: string, title?: string): Promise<Ack> => {
    const socket = socketRef.current;
    if (!socket) return Promise.resolve(DISCONNECTED_ACK);
    return socket.emitWithAck(C2S.ChangeTrack, { url, reason, title });
  }, []);

  const setVolume = useCallback((volume: number, reason?: string): Promise<Ack> => {
    const socket = socketRef.current;
    if (!socket) return Promise.resolve(DISCONNECTED_ACK);
    return socket.emitWithAck(C2S.SetVolume, { volume, reason });
  }, []);

  const togglePlay = useCallback((isPlaying: boolean, reason?: string): Promise<Ack> => {
    const socket = socketRef.current;
    if (!socket) return Promise.resolve(DISCONNECTED_ACK);
    return socket.emitWithAck(C2S.TogglePlay, { isPlaying, reason });
  }, []);

  const updateSettings = useCallback(
    (settings: Partial<RoomSettings>, reason?: string): Promise<Ack> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(DISCONNECTED_ACK);
      return socket.emitWithAck(C2S.UpdateSettings, { settings, reason });
    },
    [],
  );

  return {
    state,
    log,
    connected,
    changeTrack,
    setVolume,
    togglePlay,
    updateSettings,
  };
}
