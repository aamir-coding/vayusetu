import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import { apiProxy } from '@vayusetu/config/vite-api-proxy';
import pkg from './package.json' with { type: 'json' };
import { VitePWA } from 'vite-plugin-pwa';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tsconfigPaths(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['vayusetu-icon.svg'],
      manifest: {
        name: 'VayuSetu — Citizen Reporter',
        short_name: 'VayuSetu',
        description:
          'Report local air pollution in under 30 seconds and get an instant, plain-language safety snapshot.',
        theme_color: '#157B76',
        background_color: '#F5F8F7',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'vayusetu-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,ico,woff2}'],
        // Never let Workbox precache MSW's own worker script over the real one.
        globIgnores: ['**/mockServiceWorker.js'],
        runtimeCaching: [
          {
            // Read-only GETs (hotspot/forecast/corridor reference data etc.)
            // are fine to serve stale-while-revalidate; writes never hit
            // the cache because submission-service§4.2 has no GET-safe
            // equivalent for POST /submissions.
            urlPattern: ({ url, request }) => url.pathname.startsWith('/api/') && request.method === 'GET',
            handler: 'NetworkFirst',
            options: { cacheName: 'vayusetu-api-get', networkTimeoutSeconds: 4 },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // Same-origin /api/v1 -> the owning service (only used when VITE_USE_MOCKS=false).
  server: { port: 5173, proxy: apiProxy() },
});
