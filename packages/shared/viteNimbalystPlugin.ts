/**
 * Vite plugin for Nimbalyst monorepo
 * Based on Lexical's approach but simplified
 */
import { defineConfig, mergeConfig, type Plugin } from 'vite';
import { resolve } from 'path';

export default function viteNimbalystPlugin(): Plugin {
  return {
    name: 'vite-nimbalyst-plugin',
    enforce: 'pre',
    config(config, env) {
      const isDevMode = env.mode !== 'production';

      return mergeConfig(
        defineConfig({
          resolve: {
            alias: [
              {
                find: '@nimbalyst/runtime',
                replacement: isDevMode
                  ? resolve(__dirname, '../runtime/src/index.ts')
                  : resolve(__dirname, '../runtime/dist/index.js')
              },
              {
                find: /^@nimbalyst\/runtime\//,
                replacement: isDevMode
                  ? resolve(__dirname, '../runtime/src') + '/'
                  : resolve(__dirname, '../runtime/dist') + '/'
              }
            ]
          }
        }),
        config
      );
    }
  };
}
