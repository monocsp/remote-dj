/**
 * Fork-friendly runtime resolution of the Socket.IO server URL.
 *
 * Priority:
 *   1. NEXT_PUBLIC_SERVER_URL env override (build/deploy time).
 *   2. Same host as the current page, port 3001 (derived at runtime — no
 *      rebuild needed per host).
 *   3. localhost fallback (SSR / non-browser contexts).
 */
export function getServerUrl(): string {
  if (process.env.NEXT_PUBLIC_SERVER_URL) {
    return process.env.NEXT_PUBLIC_SERVER_URL;
  }
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:3001`;
  }
  return 'http://localhost:3001';
}
