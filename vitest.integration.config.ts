import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Config for REAL-INFRASTRUCTURE integration checks.
 *
 * Differs from vitest.config.ts in two ways that matter:
 *  - it does NOT load vitest.setup.ts, which stubs UPSTASH_REDIS_REST_URL and
 *    friends with dummy values. These tests need the genuine connection.
 *  - it runs in the node environment, not jsdom.
 *
 * Run explicitly with `npm run test:upstash`. Never part of `npm run test`.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["__tests__/integration/**/*.upstash.test.ts"],
    // Network round trips to Upstash.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Sequential: these tests share one Redis namespace.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
});
