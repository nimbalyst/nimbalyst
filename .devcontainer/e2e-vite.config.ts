/**
 * Minimal Vite config for E2E testing in containers.
 *
 * This config runs just the renderer dev server without electron-vite
 * which tries to start Electron (causing issues in containers).
 *
 * Uses the same settings as electron.vite.config.ts renderer section.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { resolve } from 'path';
import fs from 'fs';

const electronDir = resolve(__dirname, '../packages/electron');
const runtimeSrcDir = resolve(__dirname, '../packages/runtime/src');

export default defineConfig({
  root: resolve(electronDir, 'src/renderer'),
  base: '/',
  publicDir: false,
  plugins: [
    nodePolyfills({
      globals: {
        Buffer: false,
        global: false,
        process: 'build',
      },
      include: [],
      protocolImports: false,
    }),
    react(),
    (() => {
      const toPosix = (p: string) => p.replace(/\\/g, '/');
      const targets: Array<{ src: string; dest: string; overwrite?: boolean }> = [];
      const icon = resolve(electronDir, 'icon.png');
      const logo = resolve(electronDir, 'nimbalyst-logo.png');
      const esModuleShims = resolve(__dirname, '../node_modules/es-module-shims/dist/es-module-shims.js');
      const ghosttyWasm = resolve(__dirname, '../node_modules/ghostty-web/ghostty-vt.wasm');

      if (fs.existsSync(icon)) {
        targets.push({ src: toPosix(icon), dest: '', overwrite: true });
      }
      if (fs.existsSync(logo)) {
        targets.push({ src: toPosix(logo), dest: '', overwrite: true });
      }
      if (fs.existsSync(esModuleShims)) {
        targets.push({ src: toPosix(esModuleShims), dest: '', overwrite: true });
      }
      if (fs.existsSync(ghosttyWasm)) {
        targets.push({ src: toPosix(ghosttyWasm), dest: '', overwrite: true });
      }
      return viteStaticCopy({ targets });
    })()
  ],
  server: {
    host: true,  // Listen on all interfaces (0.0.0.0)
    port: 5273,
    strictPort: true,
    fs: {
      allow: ['..', '../../node_modules', '../../../node_modules']
    }
  },
  resolve: {
    alias: {
      '@nimbalyst/runtime': runtimeSrcDir
    },
    dedupe: [
      'react',
      'react-dom',
      'lexical',
      '@lexical/clipboard',
      '@lexical/code',
      '@lexical/history',
      '@lexical/link',
      '@lexical/list',
      '@lexical/mark',
      '@lexical/markdown',
      '@lexical/rich-text',
      '@lexical/selection',
      '@lexical/table',
      '@lexical/text',
      '@lexical/utils',
      '@lexical/react',
      '@nimbalyst/runtime'
    ]
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('development'),
    'process.env.IS_DEV_MODE': JSON.stringify('true'),
  }
});
