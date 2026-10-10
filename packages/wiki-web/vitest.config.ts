import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so a test run does not need a built collab-bundle for Tailwind.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
