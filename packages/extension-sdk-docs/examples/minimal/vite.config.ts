import { defineConfig } from 'vite';
import { createExtensionConfig } from '@nimbalyst/extension-sdk/vite';

export default defineConfig(createExtensionConfig({
  entry: './src/index.ts',
}));
