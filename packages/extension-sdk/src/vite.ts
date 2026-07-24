/**
 * Vite configuration helpers for Nimbalyst extensions.
 */
import type { UserConfig, PluginOption, Plugin } from 'vite';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { ROLLUP_EXTERNALS } from './externals.js';

/**
 * Creates a Vite plugin that validates the build output matches the manifest.
 * This catches issues like manifest.main pointing to a file that doesn't exist
 * (e.g., manifest says "dist/index.mjs" but Vite outputs "dist/index.js").
 *
 * The plugin runs after the build completes and fails the build if validation fails.
 *
 * @example
 * ```ts
 * import { createManifestValidationPlugin } from '@nimbalyst/extension-sdk/vite';
 *
 * export default defineConfig({
 *   plugins: [
 *     react(),
 *     createManifestValidationPlugin(),
 *   ],
 *   // ... rest of config
 * });
 * ```
 */
export function createManifestValidationPlugin(): Plugin {
  let outDir = 'dist';
  let rootDir = process.cwd();

  return {
    name: 'nimbalyst-manifest-validation',
    configResolved(config) {
      outDir = config.build.outDir;
      rootDir = config.root;
    },
    closeBundle() {
      const manifestPath = resolve(rootDir, 'manifest.json');
      if (!existsSync(manifestPath)) {
        return; // No manifest to validate against
      }

      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const errors: string[] = [];

        // Validate main JS file
        if (manifest.main) {
          const mainPath = resolve(rootDir, manifest.main);
          if (!existsSync(mainPath)) {
            errors.push(`manifest.main "${manifest.main}" not found in build output`);
          }
        }

        // Validate styles CSS file
        if (manifest.styles) {
          const stylesPath = resolve(rootDir, manifest.styles);
          if (!existsSync(stylesPath)) {
            errors.push(`manifest.styles "${manifest.styles}" not found in build output`);
          }
        }

        if (errors.length > 0) {
          console.error('\n\x1b[31m[nimbalyst-extension] Build validation failed:\x1b[0m');
          errors.forEach((err) => console.error(`  - ${err}`));
          console.error('\nMake sure your vite.config.ts output filenames match manifest.json\n');
          process.exitCode = 1;
        }
      } catch {
        // Ignore JSON parse errors - manifest might be invalid for other reasons
      }
    },
  };
}

export interface ExtensionConfigOptions {
  /**
   * Entry point for the extension (e.g., './src/index.tsx')
   */
  entry: string;

  /**
   * Output filename (without extension). Defaults to 'index'
   */
  fileName?: string;

  /**
   * Additional externals to add beyond the required ones.
   * Use this for libraries accessed via window.__nimbalyst_extensions
   */
  additionalExternals?: (string | RegExp)[];

  /**
   * Additional Vite plugins to include
   */
  plugins?: PluginOption[];

  /**
   * Whether to generate sourcemaps. Defaults to true
   */
  sourcemap?: boolean;

  /**
   * Whether to inline dynamic imports into a single file. Defaults to true.
   * Required because extensions load via blob URLs which don't support relative imports.
   */
  inlineDynamicImports?: boolean;
}

/**
 * Creates a Vite configuration for building a Nimbalyst extension.
 *
 * This sets up:
 * - Production mode and NODE_ENV for proper React JSX transform
 * - ES module output format
 * - Correct externals for host-provided dependencies
 * - Inlined dynamic imports (required for blob URL loading)
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { createExtensionConfig } from '@nimbalyst/extension-sdk/vite';
 *
 * export default createExtensionConfig({
 *   entry: './src/index.tsx',
 * });
 * ```
 */
export function createExtensionConfig(options: ExtensionConfigOptions): UserConfig {
  const {
    entry,
    fileName = 'index',
    additionalExternals = [],
    plugins = [],
    sourcemap = true,
    inlineDynamicImports = true,
  } = options;

  // Combine required externals with any additional ones
  const external = [...ROLLUP_EXTERNALS, ...additionalExternals];

  return {
    // Ensure production mode for proper JSX transform (jsx vs jsxDEV)
    mode: 'production',

    // Replace process.env.NODE_ENV at build time
    // Required for libraries that use conditional exports
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },

    plugins: [
      // Note: User must add @vitejs/plugin-react themselves with proper config:
      // react({ jsxRuntime: 'automatic', jsxImportSource: 'react' })
      ...plugins,
      // Validate build output matches manifest.json
      createManifestValidationPlugin(),
    ],

    build: {
      lib: {
        entry,
        formats: ['es'],
        fileName: () => `${fileName}.js`,
      },

      rollupOptions: {
        external,
        output: {
          // Required: Extensions load via blob URLs which can't resolve relative imports
          inlineDynamicImports,

          // Standard globals for externals
          globals: {
            react: 'React',
            'react-dom': 'ReactDOM',
            'react/jsx-runtime': 'jsxRuntime',
          },

          // Name CSS output consistently
          // Vite 7 changed assetInfo.name to assetInfo.names (array)
          assetFileNames: (assetInfo) => {
            if (assetInfo.names?.some((name) => name.endsWith('.css'))) {
              return `${fileName}.css`;
            }
            return assetInfo.names?.[0] || 'asset';
          },
        },
      },

      // Output directory
      outDir: 'dist',
      emptyOutDir: true,

      // Sourcemaps for debugging
      sourcemap,
    },
  };
}

/**
 * Merges a base extension config with custom overrides.
 * Useful when you need to extend the base config.
 *
 * @example
 * ```ts
 * import { createExtensionConfig, mergeExtensionConfig } from '@nimbalyst/extension-sdk/vite';
 *
 * const baseConfig = createExtensionConfig({ entry: './src/index.tsx' });
 *
 * export default mergeExtensionConfig(baseConfig, {
 *   resolve: {
 *     alias: { '@': './src' }
 *   }
 * });
 * ```
 */
export function mergeExtensionConfig(
  base: UserConfig,
  overrides: Partial<UserConfig>
): UserConfig {
  return {
    ...base,
    ...overrides,
    define: {
      ...base.define,
      ...overrides.define,
    },
    build: {
      ...base.build,
      ...overrides.build,
      rollupOptions: {
        ...base.build?.rollupOptions,
        ...overrides.build?.rollupOptions,
      },
    },
    resolve: {
      ...base.resolve,
      ...overrides.resolve,
    },
  };
}
