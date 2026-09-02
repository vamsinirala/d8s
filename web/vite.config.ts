import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// BASE_PATH is set when building the GitHub Pages demo (served from /d8s/demo/).
// Local dev and the release bundle both serve from the root and leave it unset.
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
  server: {
    port: 5183,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:4173',
    },
  },
})
