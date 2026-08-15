import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@earendil-works/pi-coding-agent': resolve(__dirname, 'tests/__mocks__/pi-coding-agent.ts'),
      '@earendil-works/pi-tui': resolve(__dirname, 'tests/__mocks__/pi-tui.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
