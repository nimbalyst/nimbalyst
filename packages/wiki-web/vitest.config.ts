import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Separate from vite.config.ts so a test run does not need a built collab-bundle for Tailwind.
export default defineConfig({
  resolve: {
    alias: [
      // As in vite.config.ts: runtime source the app imports directly.
      { find: /^@nimbalyst\/runtime-source\//, replacement: `${path.resolve(here, '../runtime/src')}/` },
      // Their `node` exports point at builds; tests read the source.
      { find: /^@nimbalyst\/local-wiki$/, replacement: path.resolve(here, '../local-wiki/src/index.ts') },
      { find: /^@nimbalyst\/local-wiki\/browser$/, replacement: path.resolve(here, '../local-wiki/src/browser.ts') },
      { find: /^@nimbalyst\/collab-protocol$/, replacement: path.resolve(here, '../collab-protocol/src/index.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'scripts/**/__tests__/**/*.test.ts'],
  },
});
