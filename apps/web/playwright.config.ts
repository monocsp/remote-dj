import { defineConfig, devices } from '@playwright/test';

// Black-box web E2E config. Scenarios trace to docs/qa/*.md (PAIR-*, TRK-*, RT-*, QUEUE-*).
// Two webServers so tests don't start until BOTH are ready: the socket server
// (:3001 /health) AND the web app (:3000). Waiting only on :3000 caused the
// browser to connect before :3001 was up → "연결됨" never appeared (flake).

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
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
      command: 'npm run dev:server',
      cwd: '../../',
      url: 'http://localhost:3001/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'npm run dev:web',
      cwd: '../../',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
