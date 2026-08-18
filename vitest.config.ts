import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Full-suite runs initialize many isolated SQLite databases in parallel.
    // Keep enough headroom for imports and migrations on slower CI workers.
    testTimeout: 15_000,
    hookTimeout: 30_000,
    exclude: [
      ...configDefaults.exclude,
      '.worktrees/**',
    ],
    // Many of our web tests rely on React's test utilities (act, etc.).
    // If NODE_ENV is accidentally set to "production" in the environment,
    // React switches to the production build where act() is not supported.
    // Force a safe default so local/CI runs are stable.
    env: {
      NODE_ENV: process.env.NODE_ENV && process.env.NODE_ENV !== 'production' ? process.env.NODE_ENV : 'test',
    },
  },
});
