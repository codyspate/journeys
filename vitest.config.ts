import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // A few planner tests plan routes across the whole US, which takes a few seconds on slower CI machines.
    testTimeout: 30_000
  }
})
