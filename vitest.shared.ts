/**
 * Shared Vitest base for all workspace packages.
 *
 * Packages import this object and `mergeConfig` it with their own
 * `defineProject({...})` (they do NOT extend the root `vitest.config.ts`).
 * This object is `defineProject`-compatible: it only holds project-level
 * settings common to every package (no runner-level / coverage options,
 * which live in the root config).
 */
export const sharedTestConfig = {
  test: {
    globals: true,
    clearMocks: true,
    restoreMocks: true,
  },
};

export default sharedTestConfig;
