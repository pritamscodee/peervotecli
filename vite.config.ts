/**
 * Vite configuration for the PearPass web app (root: web/).
 *
 * Bundles the Midnight SDK into the browser: polyfill aliases for Node
 * built-ins, a WASM plugin for the ledger, and multi-page entries so the
 * landing page and dashboard build as separate HTML documents.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import wasm from 'vite-plugin-wasm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, 'web');

/** Serve `/dashboard` as `dashboard.html` in both dev and preview modes. */
const mpaRewrite: Plugin = {
  name: 'pearpass-mpa-rewrite',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/dashboard' || req.url === '/dashboard/') req.url = '/dashboard.html';
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/dashboard' || req.url === '/dashboard/') req.url = '/dashboard.html';
      next();
    });
  },
};

export default defineConfig({
  root: webRoot,
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      process: 'process/browser',
      buffer: 'buffer',
      util: 'util',
      events: 'events',
      stream: 'stream-browserify',
      crypto: path.resolve(__dirname, 'web/src/lib/crypto-shim.ts'),
    },
  },
  plugins: [wasm(), mpaRewrite],
  optimizeDeps: {
    include: ['level', 'browser-level', 'abstract-level', 'level-supports', 'level-transcoder', 'cross-fetch'],
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: path.resolve(webRoot, 'index.html'),
        dashboard: path.resolve(webRoot, 'dashboard.html'),
      },
    },
  },
  worker: {
    format: 'es',
  },
  assetsInclude: ['**/*.wasm'],
  server: {
    port: 3000,
    fs: {
      // Allow web/src imports to reach ../../contracts from outside webRoot.
      allow: [path.resolve(__dirname)],
    },
  },
});