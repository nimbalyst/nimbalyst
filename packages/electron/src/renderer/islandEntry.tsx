/**
 * Entry for the menu bar island window.
 *
 * The island renders a few hundred DOM nodes from state main pushes over IPC,
 * so it has its own entry instead of `index.tsx`. Booting it through the full
 * app loaded ~2,600 modules and ~1 GB of heap, and in dev it competed with every
 * workspace window for the cold Vite server at startup. Keep this entry's import
 * graph small: no `@nimbalyst/runtime` barrel, no renderer store barrel.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '@nimbalyst/runtime/store/store';
import { MenuBarIslandApp } from './components/MenuBarIsland/MenuBarIslandApp';
import './index.css';
import { installUserTimingTrimmer } from './devtools/userTimingTrimmer';

if (process.env.NODE_ENV?.toLowerCase() === 'development') {
  installUserTimingTrimmer();
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <JotaiProvider store={store}>
    <MenuBarIslandApp />
  </JotaiProvider>,
);
