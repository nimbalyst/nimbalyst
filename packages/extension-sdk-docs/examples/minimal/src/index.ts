/**
 * Minimal Extension Entry Point
 *
 * This is the simplest possible extension structure.
 */

import { MinimalEditor } from './MinimalEditor';

// Export components referenced in manifest.json
export const components = {
  MinimalEditor,
};

// Called when extension loads
export function activate(context: { extensionPath: string }) {
  console.log('Minimal extension activated');
}

// Called when extension unloads
export function deactivate() {
  console.log('Minimal extension deactivated');
}
