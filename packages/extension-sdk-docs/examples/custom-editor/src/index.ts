/**
 * JSON Viewer Extension
 *
 * A more complete example showing:
 * - Custom editor with toolbar
 * - AI tools for data interaction
 * - CSS styling
 */

import { JsonViewer } from './components/JsonViewer';
import { aiTools } from './aiTools';
import './styles.css';

// Export components referenced in manifest
export const components = {
  JsonViewer,
};

// Export AI tools
export { aiTools };

// Extension lifecycle
export function activate(context: { extensionPath: string }) {
  console.log('JSON Viewer extension activated');
}

export function deactivate() {
  console.log('JSON Viewer extension deactivated');
}
