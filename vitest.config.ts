import { defineConfig } from 'vitest/config'

/**
 * The suite's clock is a budget for process starts, not a performance gate.
 *
 * These tests drive the real thing rather than an import: `tests/cli.test.ts` spawns
 * `node src/cli/index.ts` once per command, and every command that reaches a recipe boots the Python
 * runtime and imports numpy and scipy. In this suite's own logs, twenty-five of those tests take
 * more than a second and the slowest takes 7.7 s; the ones that went red take 2.9-3.2 s, so the 5 s
 * default left them about a second and a half. Vitest's default is a budget for a pure function;
 * applied here it measured the machine, and the whole suite reported `Test timed out in 5000ms` on
 * tests that pass in under three seconds alone — a red tree that said nothing about the tree.
 *
 * The budget is deliberately above `REQUEST_TIMEOUT_MS` in `src/core/runner.ts` (30 s), so a recipe
 * that never answers fails with the runtime's own sentence (`analysis runtime did not answer within
 * 30000 ms`), which names the thing that is stuck, rather than with the harness's.
 *
 * It does not soften an assertion: every check still runs, a wrong answer still fails at once, and
 * nothing is retried — a retry would turn a real intermittent bug into a green tick.
 */
export default defineConfig({
  test: {
    testTimeout: 45_000,
    hookTimeout: 45_000,
  },
})
