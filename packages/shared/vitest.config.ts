import { defineProject, mergeConfig } from 'vitest/config';
import sharedTestConfig from '../../vitest.shared';

export default mergeConfig(
  sharedTestConfig,
  defineProject({
    test: {
      name: 'shared',
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  }),
);
