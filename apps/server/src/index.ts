import { type Server as HttpServer, createServer as createHttpServer } from 'node:http';
import {
  type Ack,
  type ActivityEntry,
  type ActivityType,
  C2S,
  type ChangeTrackPayload,
  type JoinPayload,
  LIMITS,
  type Role,
  type RoomSettings,
  type RoomState,
  S2C,
  type SetVolumePayload,
  type TogglePlayPayload,
  type Track,
  type UpdateSettingsPayload,
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

/**
 * Wire an HTTP server + Socket.IO Server with all room handlers.
 * Exported (not auto-listening) so tests can listen on an ephemeral port.
 */
export function createServer(store: RoomStore = new InMemoryRoomStore()): {
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
      await store.patchState(room, { currentTrack: track, isPlaying: true });
      await recordActivity('track_change', reason.trim(), { id, url, title: track.title });
      ack({ ok: true });
      await broadcastState(room);
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
