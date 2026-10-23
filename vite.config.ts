import { defineConfig } from 'vite';

const api = { target: 'http://localhost:3001', changeOrigin: true, ws: true };

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    // Let the Cloudflare tunnel (and Discord's proxy behind it) reach the dev server.
    allowedHosts: ['.trycloudflare.com'],
    // Inside Discord, hot reload has to come back through the HTTPS proxy on port 443.
    hmr: process.env.TUNNEL ? { clientPort: 443 } : undefined,
    proxy: { '/api': api, '/.proxy/api': api },
  },
});
