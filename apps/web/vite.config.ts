import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const contractsEntry = fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url));

/**
 * The API resolves the tenant from the request Host header. In development the
 * dev server proxies /api and /healthz to the API and rewrites Host to the
 * tenant host (EXAMOS_TENANT_HOST, default demo.examos.local), so the API sees
 * the tenant it should serve while the browser talks to localhost.
 */
const tenantHost = process.env['EXAMOS_TENANT_HOST'] ?? 'demo.examos.local';
const apiTarget = process.env['EXAMOS_API_URL'] ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': `${here}src`,
      // The contracts package ships TypeScript source; point straight at it so Vite transforms it.
      '@examos/contracts': contractsEntry,
    },
  },
  optimizeDeps: { exclude: ['@examos/contracts'] },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false, headers: { Host: tenantHost } },
      '/healthz': { target: apiTarget, changeOrigin: false, headers: { Host: tenantHost } },
    },
  },
  build: {
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/pointer-events.ts', './test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
  },
});
