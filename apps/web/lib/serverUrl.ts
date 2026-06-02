/**
 * Fork-friendly runtime resolution of the Socket.IO server URL.
 *
 * Priority:
 *   1. NEXT_PUBLIC_SERVER_URL env override (build/deploy time).
 *   2. Same host as the current page, server port = web port + 1 (derived at
 *      runtime — no rebuild per host). This lets a prd instance (web 3000 →
 *      server 3001) and a dev instance (web 3100 → server 3101) coexist on the
 *      same machine, each web auto-targeting its own server.
 *   3. localhost:3001 fallback (SSR / non-browser / no port in URL).
 */
export function getServerUrl(): string {
  if (process.env.NEXT_PUBLIC_SERVER_URL) {
    return process.env.NEXT_PUBLIC_SERVER_URL;
  }
  if (typeof window !== 'undefined') {
    const webPort = Number(window.location.port);
    const serverPort = Number.isFinite(webPort) && webPort > 0 ? webPort + 1 : 3001;
    return `${window.location.protocol}//${window.location.hostname}:${serverPort}`;
  }
  return 'http://localhost:3001';
}
