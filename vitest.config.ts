import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    seed: 20260822,
    reporter: ["default"],
    testTimeout: 120000,
    hookTimeout: 400000,
    maxConcurrency: 4,
  },
});
