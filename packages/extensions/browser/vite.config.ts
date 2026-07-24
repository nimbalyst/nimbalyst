import react from '@vitejs/plugin-react';
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
  build: {
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        assetFileNames: (assetInfo) => {
          if (assetInfo.names?.some((name) => name.endsWith('.css'))) {
            return 'style.css';
          }
          return assetInfo.names?.[0] || 'asset';
        },
      },
    },
  },
});
