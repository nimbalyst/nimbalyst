import { mergeConfig, defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import viteConfig from './vite.config';

export default mergeConfig(viteConfig, defineConfig({
  resolve: {
    alias: [
      {
        find: /^monaco-editor(\/.*)?$/,
        replacement: resolve(import.meta.dirname, '../../test-utils/monacoStub.ts'),
      },
    ],
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    server: { deps: { inline: [/y-monaco/] } },
  },
}));
