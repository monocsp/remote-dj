import type { ActivityEntry, RoomState, Track } from '@remote-dj/shared';

/**
 * A single room's authoritative record.
 */
export interface RoomRecord {
  state: RoomState;
  log: ActivityEntry[];
  // Server-side only: optional room password. Never put on RoomState/broadcast.
  password: string | null;
  // Server-side only: tracks already played, used to rebuild the pool for
  // repeat 'all'. NOT part of RoomState — never broadcast. Capped to last 100.
  history: Track[];
}

/**
 * Storage abstraction for room state + activity logs.
 * All methods are async so the in-memory implementation can later be
 * swapped for a database-backed one without touching call sites.
 */
export interface RoomStore {
  getOrCreate(roomCode: string, initialPassword?: string | null): Promise<RoomRecord>;
  get(roomCode: string): Promise<RoomRecord | undefined>;
  patchState(roomCode: string, partial: Partial<RoomState>): Promise<RoomState>;
  appendActivity(roomCode: string, entry: ActivityEntry): Promise<void>;
  /** Replace the room's server-only play history (capped to the last 100). */
  setHistory(roomCode: string, history: Track[]): Promise<void>;
  deleteRoom(roomCode: string): Promise<void>;
}

/** Max activity entries retained per room; oldest are dropped past this. */
const MAX_LOG = 200;

/** Max play-history entries retained per room (for repeat 'all'). */
const MAX_HISTORY = 100;

function createInitialState(roomCode: string): RoomState {
  return {
    roomCode,
    currentTrack: null,
    queue: [],
    isPlaying: false,
    volume: 50,
    repeat: 'off',
    shuffle: false,
    settings: { allowAnonymous: true },
    presence: { playerConnected: false, controllers: 0 },
    updatedAt: Date.now(),
    stateVersion: 0,
    progress: null,
    lastSeek: null,
    playbackError: null,
    trackGain: {},
  };
}

export class InMemoryRoomStore implements RoomStore {
  private rooms = new Map<string, RoomRecord>();

  async getOrCreate(roomCode: string, initialPassword?: string | null): Promise<RoomRecord> {
    let record = this.rooms.get(roomCode);
    if (!record) {
      // Password is only applied when creating a brand-new record.
      record = {
        state: createInitialState(roomCode),
        log: [],
        password: initialPassword ?? null,
        history: [],
      };
      this.rooms.set(roomCode, record);
    }
    return record;
  }

  async get(roomCode: string): Promise<RoomRecord | undefined> {
    return this.rooms.get(roomCode);
  }

  async patchState(roomCode: string, partial: Partial<RoomState>): Promise<RoomState> {
    const record = await this.getOrCreate(roomCode);
    record.state = {
      ...record.state,
      ...partial,
      // roomCode is immutable for a record
      roomCode: record.state.roomCode,
      updatedAt: Date.now(),
      stateVersion: record.state.stateVersion + 1,
    };
    return record.state;
  }

  async appendActivity(roomCode: string, entry: ActivityEntry): Promise<void> {
    const record = await this.getOrCreate(roomCode);
    record.log.push(entry);
    // Keep only the most recent MAX_LOG entries (log is oldest-first; drop from the front).
    if (record.log.length > MAX_LOG) {
      record.log.splice(0, record.log.length - MAX_LOG);
    }
  }

  async setHistory(roomCode: string, history: Track[]): Promise<void> {
    const record = await this.getOrCreate(roomCode);
    // Keep only the most recent MAX_HISTORY entries (oldest-first; drop front).
    record.history =
      history.length > MAX_HISTORY ? history.slice(history.length - MAX_HISTORY) : history;
  }

  async deleteRoom(roomCode: string): Promise<void> {
    this.rooms.delete(roomCode);
  }
}
