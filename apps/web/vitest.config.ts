import react from '@vitejs/plugin-react';
import { defineProject, mergeConfig } from 'vitest/config';
import sharedTestConfig from '../../vitest.shared';

export default mergeConfig(
  sharedTestConfig,
  defineProject({
    plugins: [react()],
    test: {
      name: 'web',
      environment: 'jsdom',
      include: ['**/*.test.ts', '**/*.test.tsx'],
    },
  }),
);
