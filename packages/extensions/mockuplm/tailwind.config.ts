import baseConfig from '../../../tailwind.config.ts';
import type { Config } from 'tailwindcss';

const config: Config = {
  ...baseConfig,
  content: [
    './src/**/*.{ts,tsx,js,jsx}',
  ],
};

export default config;
