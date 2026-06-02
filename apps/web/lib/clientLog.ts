import { WEB_LOG_PATH, type WebLogEvent } from '@remote-dj/shared';
import { getServerUrl } from './serverUrl';

// Client-side error/diagnostic reporter. Buffers events and POSTs them to the
// server's WEB_LOG_PATH (the server is the authority for env/source/ts). Uses
// fetch(keepalive) normally and navigator.sendBeacon on page hide so in-flight
// reports survive navigation. De-dupes bursts of the same error. See
// docs/LOGGING.md. This never throws — logging must not break the app.

const FLUSH_DEBOUNCE_MS = 1000;
const DEDUPE_WINDOW_MS = 5000;
const MAX_QUEUE = 50;

let queue: WebLogEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const recentByKey = new Map<string, number>();

/** Ambient context merged into every report (set by the room pages). */
let context: { roomCode?: string | null; actorRole?: 'player' | 'controller' | null } = {};
export function setLogContext(ctx: {
  roomCode?: string | null;
  actorRole?: 'player' | 'controller' | null;
}): void {
  context = { ...context, ...ctx };
}

function endpoint(): string {
  return `${getServerUrl()}${WEB_LOG_PATH}`;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_DEBOUNCE_MS);
}

/** Send the buffered events. Best-effort; drops the batch on failure. */
function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  const body = JSON.stringify(batch);
  try {
    // text/plain keeps this a "simple" request (no CORS preflight); the server
    // parses the body as JSON regardless.
    void fetch(endpoint(), {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // ignore — never let logging throw
  }
}

/** Flush synchronously via sendBeacon (used on page hide / unload). */
function flushBeacon(): void {
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  try {
    const blob = new Blob([JSON.stringify(batch)], { type: 'text/plain' });
    navigator.sendBeacon?.(endpoint(), blob);
  } catch {
    // ignore
  }
}

function enqueue(ev: WebLogEvent): void {
  // De-dupe identical events seen within the window (React/Next fire twice in dev).
  if (ev.dedupeKey) {
    const now = Date.now();
    const last = recentByKey.get(ev.dedupeKey);
    if (last && now - last < DEDUPE_WINDOW_MS) return;
    recentByKey.set(ev.dedupeKey, now);
    if (recentByKey.size > 200) recentByKey.clear();
  }
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push(ev);
  scheduleFlush();
}

function errorInfo(err: unknown): WebLogEvent['error'] {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  if (typeof err === 'string') return { message: err };
  try {
    return { message: JSON.stringify(err) };
  } catch {
    return { message: 'unknown error' };
  }
}

/** Report a runtime error to the server. `partial` overrides the defaults. */
export function reportError(
  err: unknown,
  partial: Partial<WebLogEvent> & { event?: string } = {},
): void {
  if (typeof window === 'undefined') return;
  const error = partial.error ?? errorInfo(err);
  const route = window.location.pathname;
  const event = partial.event ?? 'runtime.error';
  const dedupeKey =
    partial.dedupeKey ?? `${event}:${error?.name ?? ''}:${error?.message ?? ''}:${route}`;
  enqueue({
    level: partial.level ?? 'error',
    category: partial.category ?? 'runtime',
    event,
    message: partial.message ?? error?.message ?? 'client error',
    occurredAt: new Date().toISOString(),
    route,
    roomCode: partial.roomCode ?? context.roomCode ?? null,
    actorRole: partial.actorRole ?? context.actorRole ?? null,
    dedupeKey,
    error,
    data: partial.data,
  });
}

/** Register global error handlers + page-hide flushing. Idempotent. */
let installed = false;
export function installErrorReporting(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => {
    reportError(e.error ?? e.message, { event: 'runtime.window_error' });
  });
  window.addEventListener('unhandledrejection', (e) => {
    reportError(e.reason, { event: 'runtime.unhandled_rejection' });
  });
  // Flush reliably when the page is being hidden/unloaded.
  window.addEventListener('pagehide', flushBeacon);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushBeacon();
  });
}
