import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      // Thresholds are pinned at or just below the numbers measured on the
      // suite with the 13 ledger tests running (2026-10-19):
      // global lines 76.53 / branches 67.28 / functions 83.25 / statements 75.31,
      // src/ledger/ledger.ts lines 92.64 / branches 92 / functions 89.47 / statements 92.64.
      // The per-file gate on ledger.ts exists so the tamper-evident ledger's
      // coverage cannot silently regress to the 8.8% it sat at while its
      // tests were skipped.
      thresholds: {
        lines: 76,
        branches: 67,
        functions: 83,
        statements: 75,
        "src/ledger/ledger.ts": {
          lines: 92,
          branches: 90,
          functions: 89,
          statements: 92,
        },
      },
    },
  },
});
