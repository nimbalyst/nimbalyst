import baseConfig from '../../../tailwind.config.ts';
import type { Config } from 'tailwindcss';

const config: Config = {
  ...baseConfig,
  content: {
    // relative: true resolves the globs against this config file, not the
    // build CWD — keeps the build correct no matter where it's invoked from.
    relative: true,
    files: ['./src/**/*.{ts,tsx,js,jsx}'],
  },
};

export default config;
