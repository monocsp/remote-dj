import { defineConfig } from 'vitest/config';

// Per-package vitest configs do NOT extend this root config. Instead each
// package imports `vitest.shared.ts` from the repo root and `mergeConfig`s it
// with its own `defineProject({...})`. This root config only wires up the
// project discovery + owns coverage reporting for the whole monorepo.
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
    },
  },
});
