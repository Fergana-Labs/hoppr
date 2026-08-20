import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // forks: native sqlite + process.chdir in tests are not thread-safe
    pool: 'forks',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
  },
})
