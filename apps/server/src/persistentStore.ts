import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RoomRecord } from './store.js';
import { InMemoryRoomStore } from './store.js';

/** Debounce window before a coalesced async save fires after a mutation. */
const SAVE_DEBOUNCE_MS = 800;

/**
 * File-backed RoomStore. Behaves exactly like InMemoryRoomStore but loads all
 * rooms from a JSON file on construction and persists (debounced) after every
 * mutation. All disk operations are best-effort and never throw — a corrupt or
 * missing file yields an empty store, and write errors are logged, not raised.
 *
 * Note: presence fields in state may be stale on reload; that's fine — they are
 * recomputed on every broadcast. They are not special-cased here.
 */
/** Optional hook to surface best-effort disk failures to a logger. */
export type StoreErrorHandler = (op: 'load' | 'save', filePath: string, err: unknown) => void;

export class PersistentRoomStore extends InMemoryRoomStore {
  private readonly filePath: string;
  private readonly onError?: StoreErrorHandler;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(filePath: string, onError?: StoreErrorHandler) {
    super();
    this.filePath = filePath;
    this.onError = onError;

    // Load existing rooms (best-effort: missing/corrupt file ⇒ start empty).
    try {
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw) as Record<string, RoomRecord>;
        this.loadRecords(data);
      }
    } catch (err) {
      console.warn(`[PersistentRoomStore] failed to load ${filePath}:`, err);
      this.onError?.('load', filePath, err);
    }

    // Persist immediately on a clean shutdown so we don't lose the debounce window.
    const flushOnExit = () => this.flush();
    process.on('exit', flushOnExit);
    process.on('SIGINT', flushOnExit);
    process.on('SIGTERM', flushOnExit);
  }

  /** Schedule a debounced, coalesced save. */
  protected override onMutate(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DEBOUNCE_MS);
    // Never keep the process alive just to flush a pending save.
    this.saveTimer.unref();
  }

  /** Persist the current snapshot now (synchronous). Never throws. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }

  /**
   * Write the current snapshot to disk: write to a temp file then rename over
   * the target (atomic-ish). Best-effort — logs and swallows any error.
   */
  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.dumpRecords()), 'utf8');
      renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn(`[PersistentRoomStore] failed to save ${this.filePath}:`, err);
      this.onError?.('save', this.filePath, err);
    }
  }
}
