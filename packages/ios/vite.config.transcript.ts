import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';

/**
 * Separate Vite config for building the transcript web app.
 * This produces a standalone bundle for WKWebView that doesn't share
 * chunks with the main Capacitor app (avoids pulling in Monaco, Excalidraw, etc).
 *
 * Usage: npx vite build --config vite.config.transcript.ts
 * Output: dist-transcript/transcript.html + assets/
 */
export default defineConfig({
  plugins: [
    react({
      jsxRuntime: 'automatic',
      include: [
        '**/*.tsx',
        '**/*.ts',
        '**/*.jsx',
        '**/*.js',
        '../runtime/**/*.{tsx,ts,jsx,js}',
      ],
    }),
    // Fix script tags for file:// loading in WKWebView:
    // - Strip crossorigin (CORS rejects file:// origin null)
    // - Replace type="module" with defer (modules enforce CORS; defer preserves execution order)
    {
      name: 'wkwebview-compat',
      transformIndexHtml(html) {
        return html
          .replace(/ crossorigin/g, '')
          .replace(/ type="module"/g, ' defer');
      },
    },
  ],
  resolve: {
    alias: {
      '@nimbalyst/runtime': fileURLToPath(new URL('../runtime/src', import.meta.url)),
      '@nimbalyst/extension-sdk/file-tree': fileURLToPath(new URL('../extension-sdk/src/fileDirectoryTree.ts', import.meta.url)),
      '@nimbalyst/extension-sdk': fileURLToPath(new URL('../extension-sdk/src', import.meta.url)),
    },
  },
  base: './',
  build: {
    outDir: 'dist-transcript',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        transcript: resolve(__dirname, 'transcript.html'),
      },
      output: {
        // IIFE format for WKWebView file:// compatibility (no ES module CORS issues)
        format: 'iife',
      },
    },
  },
});
