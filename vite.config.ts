import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev proxy to the public DeepBookV3 indexer so the app works even if the
// indexer's CORS policy changes. The client tries the direct URL first and
// falls back to /dbapi automatically.
export default defineConfig({
  base: process.env.GITHUB_PAGES ? '/deepbook-market-os/' : '/',
  plugins: [react()],
  server: {
    proxy: {
      '/dbapi': {
        target: 'https://deepbook-indexer.mainnet.mystenlabs.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/dbapi/, ''),
      },
    },
  },
})
