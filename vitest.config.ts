import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // Real-infrastructure checks are opt-in via `npm run test:upstash`.
    // They talk to live Upstash and must never run in the normal suite or CI.
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.upstash.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
});
