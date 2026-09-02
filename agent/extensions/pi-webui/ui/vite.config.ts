import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  build: {
    outDir: resolve(__dirname, '..', 'static'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3100',
      '/ws': {
        target: 'ws://localhost:3100',
        ws: true,
      },
    },
  },
})
