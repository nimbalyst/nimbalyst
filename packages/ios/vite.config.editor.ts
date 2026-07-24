import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';

/**
 * Vite config for building the mobile Lexical editor bundle.
 * Produces a standalone bundle for WKWebView with the full Lexical plugin set
 * (minus desktop-only plugins like DiffPlugin, SpeechToText, DraggableBlock).
 *
 * Usage: npx vite build --config vite.config.editor.ts
 * Output: dist-editor/editor.html + assets/
 */
export default defineConfig({
  plugins: [
    // Stub the Anthropic SDK's Node-only agent-toolset out of this browser
    // bundle. @nimbalyst/runtime value-imports @anthropic-ai/sdk (ai/models.ts,
    // for the model picker); the SDK's beta-sessions code in turn dynamically
    // imports `tools/agent-toolset/node` -- server-side file tools built on
    // node:fs/path/crypto. Those make named Node-builtin imports (randomUUID,
    // realpath, ...) that Vite externalizes to __vite-browser-external (no named
    // exports), which is a hard build error. The agent-toolset has no place in a
    // WKWebView and never runs there, so resolve it to an empty module.
    {
      name: 'stub-anthropic-agent-toolset',
      enforce: 'pre' as const,
      resolveId(source: string) {
        if (source.includes('tools/agent-toolset')) {
          return '\0anthropic-agent-toolset-stub';
        }
        return null;
      },
      load(id: string) {
        if (id === '\0anthropic-agent-toolset-stub') {
          return 'export default {};';
        }
        return null;
      },
    },
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
    },
  },
  base: './',
  build: {
    outDir: 'dist-editor',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        editor: resolve(__dirname, 'editor.html'),
      },
      output: {
        // IIFE format for WKWebView file:// compatibility (no ES module CORS issues)
        format: 'iife',
      },
    },
  },
});
