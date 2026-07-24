import baseConfig from '../../tailwind.config.ts';

/** @type {import('tailwindcss').Config} */
export default {
  ...baseConfig,
  content: [
    './index.html',
    './src/**/*.{ts,tsx,js,jsx}',
    '../runtime/src/**/*.{ts,tsx,js,jsx}',
  ],
}

