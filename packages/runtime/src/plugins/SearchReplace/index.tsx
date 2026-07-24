import { useEffect } from 'react';
import { FixedTabHeaderRegistry } from '../shared/fixedTabHeader/FixedTabHeaderRegistry';
import type { TabContext } from '../shared/fixedTabHeader/types';
import { SearchReplaceBar } from './SearchReplaceBar';
import { SearchReplaceStateManager } from './SearchReplaceStateManager';
import { isLexicalSearchEditor } from './isLexicalSearchEditor';

/**
 * SearchReplacePlugin
 *
 * Registers the SearchReplaceBar with the FixedTabHeaderRegistry.
 * The bar is shown when search is open for a tab.
 */
export function SearchReplacePlugin() {
  useEffect(() => {
    const registry = FixedTabHeaderRegistry.getInstance();

    // Register the search/replace bar provider
    registry.register({
      id: 'search-replace-bar',
      priority: 90, // Lower than the diff approval header (priority 100) so the diff bar renders first
      shouldRender: (context: TabContext) => {
        return !!context.filePath && isLexicalSearchEditor(context.editor);
      },
      component: SearchReplaceBar,
    });

    return () => {
      registry.unregister('search-replace-bar');
    };
  }, []);

  return null; // Plugin doesn't render anything itself
}

// Export components and utilities for external use
export { SearchReplaceBar } from './SearchReplaceBar';
export { SearchReplaceStateManager } from './SearchReplaceStateManager';
export { isLexicalSearchEditor } from './isLexicalSearchEditor';
export type { SearchReplaceState } from './SearchReplaceStateManager';
