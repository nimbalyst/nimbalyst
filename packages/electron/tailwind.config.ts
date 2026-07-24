/**
 * Electron Package Tailwind Configuration
 *
 * Extends the shared monorepo Tailwind config with Electron-specific settings.
 */

import baseConfig from '../../tailwind.config';
import type { Config } from 'tailwindcss';

const config: Config = {
  ...baseConfig,
  content: [
    './src/renderer/**/*.{ts,tsx,js,jsx}',
    // Include runtime components (AI, editor, etc.)
    '../runtime/src/**/*.{ts,tsx,js,jsx}',
  ],
};

export default config;
