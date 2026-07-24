import react from '@vitejs/plugin-react';
import { createExtensionConfig, mergeExtensionConfig } from '@nimbalyst/extension-sdk/vite';
import { resolve } from 'path';

const baseConfig = createExtensionConfig({
  entry: './src/index.tsx',
  plugins: [
    react({
      jsxRuntime: 'automatic',
      jsxImportSource: 'react',
    }),
  ],
});

export default mergeExtensionConfig(baseConfig, {
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
