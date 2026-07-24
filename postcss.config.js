/**
 * Nimbalyst Monorepo PostCSS Configuration
 *
 * This is the shared PostCSS configuration for all packages in the monorepo.
 * Individual packages can extend or override this configuration as needed.
 */
import { fileURLToPath } from 'url';

export default {
  plugins: {
    tailwindcss: {
      // fileURLToPath, not URL.pathname: on Windows pathname returns "/D:/..."
      // which is not a valid filesystem path and tailwind fails to load the
      // config silently, surfacing later as "Cannot read properties of
      // undefined (reading 'blocklist')" in setupContextUtils.
      config: fileURLToPath(new URL('./tailwind.config.ts', import.meta.url)),
    },
    autoprefixer: {},
  },
};
