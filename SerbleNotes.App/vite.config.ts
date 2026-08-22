import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// The Rust core lives outside this package and is compiled to WASM by `npm run build:core`. It is
// imported by relative path rather than installed as a dependency so there is exactly one copy of
// the crypto in the repo, and no build step where the app could silently use a stale one.
const CORE = fileURLToPath(new URL('../SerbleNotes.Core/pkg/serblenotes_core.js', import.meta.url))
const CORE_DIR = fileURLToPath(new URL('../SerbleNotes.Core/pkg', import.meta.url))

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@core': CORE },
  },
  server: {
    port: 3000,
    fs: {
      // The dev server has to be allowed to read the core's pkg/ directory, which sits above root.
      allow: ['.', CORE_DIR],
    },
    // In development the app is served by Vite for HMR, so the API and the sync socket are proxied
    // to the backend. In production neither exists: the backend serves this app itself.
    proxy: {
      '/api': {
        target: 'http://localhost:5179',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    // Published straight into the backend's wwwroot; the backend serves it from there.
    outDir: '../SerbleNotes.Backend/wwwroot',
    emptyOutDir: true,
  },
})
