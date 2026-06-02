import { defineProject, mergeConfig } from 'vitest/config';
import { sharedTestConfig } from '../../vitest.shared.js';

export default mergeConfig(
  sharedTestConfig,
  defineProject({
    test: {
      name: 'server',
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  }),
);
