import type { ActivityEntry, RoomState } from '@remote-dj/shared';

/**
 * A single room's authoritative record.
 */
export interface RoomRecord {
  state: RoomState;
  log: ActivityEntry[];
}

/**
 * Storage abstraction for room state + activity logs.
 * All methods are async so the in-memory implementation can later be
 * swapped for a database-backed one without touching call sites.
 */
export interface RoomStore {
  getOrCreate(roomCode: string): Promise<RoomRecord>;
  get(roomCode: string): Promise<RoomRecord | undefined>;
  patchState(roomCode: string, partial: Partial<RoomState>): Promise<RoomState>;
  appendActivity(roomCode: string, entry: ActivityEntry): Promise<void>;
}

function createInitialState(roomCode: string): RoomState {
  return {
    roomCode,
    currentTrack: null,
    isPlaying: false,
    volume: 50,
    settings: { allowAnonymous: true },
    presence: { playerConnected: false, controllers: 0 },
    updatedAt: Date.now(),
  };
}

export class InMemoryRoomStore implements RoomStore {
  private rooms = new Map<string, RoomRecord>();

  async getOrCreate(roomCode: string): Promise<RoomRecord> {
    let record = this.rooms.get(roomCode);
    if (!record) {
      record = { state: createInitialState(roomCode), log: [] };
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
    };
    return record.state;
  }

  async appendActivity(roomCode: string, entry: ActivityEntry): Promise<void> {
    const record = await this.getOrCreate(roomCode);
    record.log.push(entry);
  }
}
