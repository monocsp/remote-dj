import { defineConfig, devices } from '@playwright/test';

// Black-box web E2E config. Scenarios trace to docs/qa/*.md (PAIR-*, TRK-*, RT-*).
// The webServer starts the WHOLE app from the repo root via `npm run dev`,
// which `concurrently` launches as server(:3001) + web(:3000). We only point
// the baseURL at the web app; the server comes up alongside it.

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
  webServer: {
    command: 'npm run dev',
    cwd: '../../',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
