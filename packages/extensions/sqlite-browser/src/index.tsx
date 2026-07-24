/**
 * SQLite Browser Extension
 *
 * A custom editor extension for browsing and querying SQLite databases.
 * - Custom Editor: Double-click .db/.sqlite files in file tree to open
 *
 * Note: Panel support is temporarily disabled but may return in the future.
 */

// Panel temporarily disabled - may return in the future
// import { SQLiteBrowserPanel } from './SQLiteBrowserPanel';
import { SQLiteEditor } from './SQLiteEditor';
import { aiTools as sqliteAITools } from './aiTools';

/**
 * Extension activation
 */
export async function activate() {
  console.log('[SQLite Browser] Extension activated');
}

/**
 * Extension deactivation
 */
export async function deactivate() {
  console.log('[SQLite Browser] Extension deactivated');
}

/**
 * Custom editor components - keyed by component name from manifest.json
 * The extension system looks for a "components" export for custom editors.
 */
export const components = {
  SQLiteEditor,
};

/**
 * Panel exports - keyed by panel ID from manifest.json
 * Temporarily disabled - may return in the future
 */
// export const panels = {
//   browser: {
//     component: SQLiteBrowserPanel,
//   },
// };

/**
 * AI tools exported by this extension
 * These enable Claude to query and analyze SQLite databases.
 */
export const aiTools = sqliteAITools;
