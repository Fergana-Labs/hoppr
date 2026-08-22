import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // forks: native sqlite + process.chdir in tests are not thread-safe
    pool: 'forks',
    include: ['test/**/*.test.ts'],
    // Every worker gets a throwaway HOME. Tests install skills, and a run
    // once wrote three of them into the developer's real ~/.claude/skills.
    setupFiles: ['test/setup.ts'],
    testTimeout: 20_000,
  },
})
