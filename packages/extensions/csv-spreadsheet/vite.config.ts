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
  build: {
    rollupOptions: {
      output: {
        // Required: Extensions load via blob URLs which can't resolve relative imports
        inlineDynamicImports: true,
        // Vite 7 changed how CSS files are named - force it to use index.css
        assetFileNames: (assetInfo) => {
          if (assetInfo.names?.some((name) => name.endsWith('.css'))) {
            return 'index.css';
          }
          return assetInfo.names?.[0] || 'asset';
        },
      },
    },
  },
});
