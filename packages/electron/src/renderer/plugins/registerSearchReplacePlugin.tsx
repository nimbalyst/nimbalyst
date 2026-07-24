/**
 * Register the SearchReplacePlugin with the Electron app
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SearchReplacePlugin } from '@nimbalyst/runtime';

/**
 * Registers the SearchReplacePlugin globally
 */
export function registerSearchReplacePlugin() {
  // Create a hidden container for the plugin
  const container = document.createElement('div');
  container.id = 'search-replace-plugin-root';
  container.style.display = 'none';
  document.body.appendChild(container);

  const root = createRoot(container);
  root.render(<SearchReplacePlugin />);
}
