import { defineConfig, devices } from '@playwright/test';

// Black-box web E2E config. Scenarios trace to docs/qa/*.md (PAIR-*, TRK-*, RT-*, QUEUE-*).
// Two webServers so tests don't start until BOTH are ready: the socket server
// (:3001 /health) AND the web app (:3000). Waiting only on :3000 caused the
// browser to connect before :3001 was up → "연결됨" never appeared (flake).

// Ports are overridable so e2e can run BESIDE a live prd instance (web 3000 /
// server 3001 — reuseExistingServer would otherwise grab prd and pollute it):
// `E2E_WEB_PORT=3100 npm run e2e` runs web 3100 / server 3101. The web app
// auto-targets web-port+1 at runtime (lib/serverUrl.ts), so no other wiring.
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3000);
const SERVER_PORT = WEB_PORT + 1;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      // Mobile-first: the Controller web is a phone-sized responsive UI (SPEC §화면).
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: [
    {
      command: `PORT=${SERVER_PORT} npm run dev:server`,
      cwd: '../../',
      url: `http://localhost:${SERVER_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `PORT=${WEB_PORT} npm run dev:web`,
      cwd: '../../',
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
