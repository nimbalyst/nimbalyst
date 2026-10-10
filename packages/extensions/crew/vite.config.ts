import react from '@vitejs/plugin-react';
import { createExtensionConfig } from '@nimbalyst/extension-sdk/vite';

// Panel bundle (dist/index.js + dist/index.css). The backend module is a
// separate build: vite.backend.config.ts.
export default createExtensionConfig({
  entry: './src/index.tsx',
  plugins: [
    react({
      jsxRuntime: 'automatic',
      jsxImportSource: 'react',
    }),
  ],
});
