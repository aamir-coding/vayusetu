import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import { apiProxy } from '@vayusetu/config/vite-api-proxy';
import pkg from './package.json' with { type: 'json' };

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // Same-origin /api/v1 -> the owning service (only used when VITE_USE_MOCKS=false).
  server: { port: 5174, proxy: apiProxy() },
});
