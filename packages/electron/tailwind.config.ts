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
    // Shared Docs UI (CollabSidebar, SharedDocsListView, SharedDocsHome) moved
    // out of src/renderer into collab-client so the browser host can reuse it.
    // Without this glob its utilities are generated only by coincidence, when
    // some other renderer file happens to use the same class.
    '../collab-client/src/**/*.{ts,tsx,js,jsx}',
  ],
};

export default config;
