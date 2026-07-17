/**
 * Extension-local PostCSS config.
 *
 * Without this, Vite falls back to the monorepo root postcss.config.js whose
 * tailwind config resolves content globs against the build CWD (this
 * directory), matching nothing — so every utility class is purged from
 * dist/index.css. In the app that's masked by the host's stylesheet, but the
 * web share viewer loads dist/index.css standalone and needs the utilities.
 */
import { fileURLToPath } from 'url';

export default {
  plugins: {
    tailwindcss: {
      config: fileURLToPath(new URL('./tailwind.config.ts', import.meta.url)),
    },
    autoprefixer: {},
  },
};
