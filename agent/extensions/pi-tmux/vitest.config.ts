import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@earendil-works/pi-coding-agent': resolve(import.meta.dirname, '../pi-memory/tests/__mocks__/pi-coding-agent.ts'),
      '@earendil-works/pi-agent-core': resolve(import.meta.dirname, '../pi-memory/tests/__mocks__/pi-coding-agent.ts'),
      '@earendil-works/pi-ai': resolve(import.meta.dirname, '../pi-memory/tests/__mocks__/pi-coding-agent.ts'),
      '@earendil-works/pi-tui': resolve(import.meta.dirname, '../pi-memory/tests/__mocks__/pi-coding-agent.ts'),
      'typebox': resolve(import.meta.dirname, '../pi-memory/tests/__mocks__/typebox.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
