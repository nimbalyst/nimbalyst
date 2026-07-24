import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { createExtensionConfig, mergeExtensionConfig } from '@nimbalyst/extension-sdk/vite';

const baseConfig = createExtensionConfig({
  entry: './src/index.tsx',
  plugins: [
    react({
      jsxRuntime: 'automatic',
      jsxImportSource: 'react',
    }),
  ],
  sourcemap: false,
});

export default mergeExtensionConfig(baseConfig, {
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
