import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';

/**
 * Vite config for the mobile Lexical editor bundle loaded by the document
 * editor WebView (file:///android_asset/editor-dist/editor.html).
 * Forked from packages/ios/vite.config.editor.ts.
 *
 * Usage: npm run build:editor
 * Output: dist-editor/editor.html + assets/, synced into the APK by the
 * sync<Variant>EditorAssets Gradle task.
 */
export default defineConfig({
  plugins: [
    // @nimbalyst/runtime value-imports @anthropic-ai/sdk, whose beta-sessions
    // code dynamically imports a Node-only agent toolset (node:fs/path/crypto
    // named imports), which is a hard build error in a browser bundle. It never
    // runs in the WebView, so resolve it to an empty module.
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
    // file:// loading: module scripts enforce CORS against the null origin, so
    // strip crossorigin and load the IIFE with defer (same as the transcript).
    {
      name: 'android-webview-compat',
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
        format: 'iife',
      },
    },
  },
});
