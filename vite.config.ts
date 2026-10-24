import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The frontend is a plain SPA. `/api/*` is served by Cloudflare Pages Functions in
// production and proxied to `wrangler pages dev` (or the bundled Node server)
// during local development.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.LINKMEDIC_API ?? 'http://127.0.0.1:8788',
        changeOrigin: true,
      },
    },
  },
});
