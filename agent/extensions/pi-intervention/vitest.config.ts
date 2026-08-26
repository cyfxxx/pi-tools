import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@earendil-works/pi-coding-agent': resolve(__dirname, '../pi-memory/tests/__mocks__/pi-coding-agent.ts'),
      '@earendil-works/pi-agent-core': resolve(__dirname, '../pi-memory/tests/__mocks__/pi-coding-agent.ts'),
      '@earendil-works/pi-ai': resolve(__dirname, '../pi-memory/tests/__mocks__/pi-coding-agent.ts'),
      '@earendil-works/pi-tui': resolve(__dirname, '../pi-memory/tests/__mocks__/pi-coding-agent.ts'),
      'typebox': resolve(__dirname, '../pi-memory/tests/__mocks__/typebox.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
