import { defineConfig } from "vitest/config";

const runLive = process.env.RUN_LIVE_TESTS === "1";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: runLive ? [] : ["tests/live-smoke.test.ts"],
    globals: false,
    pool: "forks",
    testTimeout: 10_000,
    passWithNoTests: true,
  },
});
