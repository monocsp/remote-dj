import type { ActivityEntry, RoomState } from '@remote-dj/shared';

/**
 * A single room's authoritative record.
 */
export interface RoomRecord {
  state: RoomState;
  log: ActivityEntry[];
  // Server-side only: optional room password. Never put on RoomState/broadcast.
  password: string | null;
}

/**
 * Storage abstraction for room state + activity logs.
 * All methods are async so the in-memory implementation can later be
 * swapped for a database-backed one without touching call sites.
 */
export interface RoomStore {
  getOrCreate(roomCode: string, initialPassword?: string | null): Promise<RoomRecord>;
  get(roomCode: string): Promise<RoomRecord | undefined>;
  /** List the codes of all rooms currently held by the store. */
  listRoomCodes(): Promise<string[]>;
  patchState(roomCode: string, partial: Partial<RoomState>): Promise<RoomState>;
  appendActivity(roomCode: string, entry: ActivityEntry): Promise<void>;
  /**
   * Backfill `detail.title` on existing log entries for `videoId` that were
   * stamped before the title resolved. Returns true if anything changed.
   * Goes through the store (vs. mutating record.log directly) so persistence
   * subclasses see the change via onMutate.
   */
  backfillActivityTitle(roomCode: string, videoId: string, title: string): Promise<boolean>;
  deleteRoom(roomCode: string): Promise<void>;
}

/** Max activity entries retained per room; oldest are dropped past this. */
const MAX_LOG = 200;

function createInitialState(roomCode: string): RoomState {
  return {
    roomCode,
    playlist: [],
    currentIndex: -1,
    blockedIds: [],
    isPlaying: false,
    volume: 50,
    repeat: 'off',
    settings: { allowAnonymous: true },
    presence: { playerConnected: false, controllers: 0 },
    updatedAt: Date.now(),
    stateVersion: 0,
    progress: null,
    lastSeek: null,
    playbackError: null,
    trackGain: {},
    schedule: null,
  };
}

export class InMemoryRoomStore implements RoomStore {
  // protected so a persistence subclass can serialize the contents.
  protected rooms = new Map<string, RoomRecord>();

  /**
   * Hook invoked at the END of every mutating method (getOrCreate when it
   * actually CREATES a record, patchState, appendActivity, backfillActivityTitle,
   * deleteRoom). In-memory: no-op. Subclasses override to persist.
   */
  protected onMutate(): void {}

  /** Plain serializable snapshot of all rooms (for persistence). */
  protected dumpRecords(): Record<string, RoomRecord> {
    const out: Record<string, RoomRecord> = {};
    for (const [code, record] of this.rooms) {
      out[code] = record;
    }
    return out;
  }

  /**
   * Replace the Map contents from a parsed snapshot. Defensive: only accept
   * entries that look like a RoomRecord (have a `.state` object).
   */
  protected loadRecords(data: Record<string, RoomRecord>): void {
    this.rooms.clear();
    if (!data || typeof data !== 'object') return;
    for (const [code, record] of Object.entries(data)) {
      if (record && typeof record === 'object' && typeof record.state === 'object') {
        // Migrate/normalize legacy state (e.g. pre-playlist rooms with
        // currentTrack/queue/history) so loading old .data never yields a
        // malformed RoomState. Missing fields fall back to the initial state.
        const raw = record.state as unknown as Record<string, unknown>;
        record.state = {
          ...createInitialState(code),
          ...record.state,
          roomCode: code,
          playlist: Array.isArray(raw.playlist) ? (raw.playlist as RoomState['playlist']) : [],
          currentIndex: typeof raw.currentIndex === 'number' ? (raw.currentIndex as number) : -1,
        };
        // Drop dead legacy fields if present.
        const s = record.state as unknown as Record<string, unknown>;
        for (const k of ['currentTrack', 'queue', 'history', 'shuffle']) delete s[k];
        if (!Array.isArray(record.log)) record.log = [];
        this.rooms.set(code, record as RoomRecord);
      }
    }
  }

  async getOrCreate(roomCode: string, initialPassword?: string | null): Promise<RoomRecord> {
    let record = this.rooms.get(roomCode);
    if (!record) {
      // Password is only applied when creating a brand-new record.
      record = {
        state: createInitialState(roomCode),
        log: [],
        password: initialPassword ?? null,
      };
      this.rooms.set(roomCode, record);
      this.onMutate();
    }
    return record;
  }

  async get(roomCode: string): Promise<RoomRecord | undefined> {
    return this.rooms.get(roomCode);
  }

  async listRoomCodes(): Promise<string[]> {
    return [...this.rooms.keys()];
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
    this.onMutate();
    return record.state;
  }

  async appendActivity(roomCode: string, entry: ActivityEntry): Promise<void> {
    const record = await this.getOrCreate(roomCode);
    record.log.push(entry);
    // Keep only the most recent MAX_LOG entries (log is oldest-first; drop from the front).
    if (record.log.length > MAX_LOG) {
      record.log.splice(0, record.log.length - MAX_LOG);
    }
    this.onMutate();
  }

  async backfillActivityTitle(roomCode: string, videoId: string, title: string): Promise<boolean> {
    const record = this.rooms.get(roomCode);
    if (!record) return false;
    let changed = false;
    for (const e of record.log) {
      const d = e.detail as Record<string, unknown> | undefined;
      if (d && d.id === videoId && (d.title === null || d.title === undefined)) {
        e.detail = { ...d, title };
        changed = true;
      }
    }
    if (changed) this.onMutate();
    return changed;
  }

  async deleteRoom(roomCode: string): Promise<void> {
    this.rooms.delete(roomCode);
    this.onMutate();
  }
}
