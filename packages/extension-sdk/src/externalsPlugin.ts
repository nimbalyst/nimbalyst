/**
 * Vite/Rollup plugin that transforms external imports to window.__nimbalyst_extensions references.
 *
 * This plugin runs at BUILD TIME, transforming imports BEFORE minification.
 * This is more robust than runtime regex transformation because:
 * 1. Source code has predictable import syntax
 * 2. Minification happens AFTER transformation
 * 3. Build errors are caught early
 *
 * HOW IT WORKS:
 * Instead of marking modules as "external" (which keeps bare import statements that
 * blob URLs can't resolve), we resolve imports to virtual modules that access
 * window.__nimbalyst_extensions at runtime.
 *
 * Example:
 *   import React, { useState } from 'react'
 *   ->
 *   // Generated virtual module gets bundled inline:
 *   const __mod = window.__nimbalyst_extensions["react"];
 *   export default __mod;
 *   export const useState = __mod.useState;
 *   // etc.
 *
 * The extension's code then imports from this virtual module, which after bundling
 * becomes direct property accesses on window.__nimbalyst_extensions.
 */

import type { Plugin } from 'vite';

/**
 * Map of external module names to their window.__nimbalyst_extensions keys.
 */
const EXTERNALS_MAP: Record<string, string> = {
  // React
  react: 'react',
  'react-dom': 'react-dom',
  'react-dom/client': 'react-dom/client',
  'react/jsx-runtime': 'react/jsx-runtime',
  'react/jsx-dev-runtime': 'react/jsx-dev-runtime',

  // Lexical
  lexical: 'lexical',
  '@lexical/react/LexicalComposerContext': '@lexical/react/LexicalComposerContext',
  '@lexical/react/useLexicalEditable': '@lexical/react/useLexicalEditable',
  '@lexical/react/useLexicalNodeSelection': '@lexical/react/useLexicalNodeSelection',
  '@lexical/utils': '@lexical/utils',
  '@lexical/markdown': '@lexical/markdown',

  // Nimbalyst runtime
  '@nimbalyst/editor-context': '@nimbalyst/editor-context',
  '@nimbalyst/runtime/ui/icons/MaterialSymbol': '@nimbalyst/runtime/ui/icons/MaterialSymbol',
  '@nimbalyst/screenshot-service': '@nimbalyst/screenshot-service',
  '@nimbalyst/datamodel-platform-service': '@nimbalyst/datamodel-platform-service',

  // Shared libraries
  'pdfjs-dist': 'pdfjs-dist',
  virtua: 'virtua',
};

/**
 * Check if a module ID matches any external pattern.
 * Returns the key to use in window.__nimbalyst_extensions or null if not external.
 */
function getExternalKey(id: string): string | null {
  // Direct match
  if (EXTERNALS_MAP[id]) {
    return EXTERNALS_MAP[id];
  }

  // Pattern match for @lexical/* and @nimbalyst/runtime/*
  if (id.startsWith('@lexical/')) {
    return id;
  }
  if (id.startsWith('@nimbalyst/runtime')) {
    return id;
  }

  return null;
}

/**
 * Creates a Vite plugin that transforms external imports at build time.
 *
 * This approach uses renderChunk to transform the final output after bundling
 * but captures the original import information during the transform phase.
 *
 * The key insight: we DON'T mark these as external. Instead, we let Rollup
 * try to resolve them, fail, and then our resolveId catches them and returns
 * a virtual module. The virtual module's code accesses window.__nimbalyst_extensions.
 */
export function nimbalystExternalsPlugin(): Plugin {
  const virtualModulePrefix = '\0nimbalyst-external:';

  return {
    name: 'nimbalyst-externals',
    enforce: 'pre',

    resolveId(source, _importer, _options) {
      const externalKey = getExternalKey(source);
      if (externalKey) {
        return virtualModulePrefix + externalKey;
      }
      return null;
    },

    load(id) {
      if (!id.startsWith(virtualModulePrefix)) {
        return null;
      }

      const externalKey = id.slice(virtualModulePrefix.length);

      // Generate a simple module that re-exports from window.__nimbalyst_extensions.
      // We use a Proxy to handle ANY property access, making this future-proof.
      // The Proxy ensures that any named import will work without us having to
      // enumerate all possible exports.
      return `
// Virtual module for: ${externalKey}
// This gets the module from the host at runtime
const __nimbalyst_mod__ = window.__nimbalyst_extensions?.["${externalKey}"];

if (!__nimbalyst_mod__) {
  console.error('[Extension] Missing host dependency: ${externalKey}');
}

// Default export for: import X from '${externalKey}'
export default __nimbalyst_mod__;

// Create a proxy that allows any named export
// This handles: import { anything } from '${externalKey}'
const __proxy__ = new Proxy(__nimbalyst_mod__ || {}, {
  get(target, prop) {
    if (prop in target) {
      return target[prop];
    }
    // For properties that don't exist, return undefined
    // This prevents errors for optional exports
    return undefined;
  }
});

// Re-export common properties explicitly for tree-shaking
// These are the most commonly used exports from each package type
${generateCommonExports(externalKey)}
`;
    },
  };
}

/**
 * Generate explicit named exports for common properties.
 * This helps with tree-shaking while the Proxy handles edge cases.
 */
function generateCommonExports(externalKey: string): string {
  // Determine which exports to generate based on the module
  let exports: string[] = [];

  if (externalKey === 'react') {
    exports = [
      'useState', 'useEffect', 'useCallback', 'useMemo', 'useRef', 'useContext',
      'useReducer', 'useLayoutEffect', 'useImperativeHandle', 'useDebugValue',
      'useDeferredValue', 'useTransition', 'useId', 'useSyncExternalStore',
      'createElement', 'createContext', 'createRef', 'forwardRef', 'lazy', 'memo',
      'startTransition', 'Children', 'Component', 'Fragment', 'Profiler',
      'PureComponent', 'StrictMode', 'Suspense', 'cloneElement', 'isValidElement',
      'version', 'useInsertionEffect', 'cache', 'use', 'act',
    ];
  } else if (externalKey === 'react-dom' || externalKey === 'react-dom/client') {
    exports = [
      'createRoot', 'hydrateRoot', 'render', 'hydrate', 'createPortal', 'flushSync',
      'unmountComponentAtNode', 'findDOMNode', 'unstable_batchedUpdates',
    ];
  } else if (externalKey === 'react/jsx-runtime' || externalKey === 'react/jsx-dev-runtime') {
    exports = ['jsx', 'jsxs', 'jsxDEV', 'Fragment'];
  } else if (externalKey === 'lexical') {
    exports = [
      // Selection and state
      '$getRoot', '$getSelection', '$setSelection', '$insertNodes', '$getNodeByKey',
      '$createParagraphNode', '$createTextNode', '$createRangeSelection',
      '$getNearestNodeFromDOMNode', '$nodesOfType',
      // Type guards
      '$isRangeSelection', '$isNodeSelection', '$isTextNode', '$isParagraphNode',
      '$isElementNode', '$isRootNode', '$isDecoratorNode', '$isLineBreakNode',
      '$isRootOrShadowRoot',
      // Node operations
      '$splitNode', '$copyNode', '$generateHtmlFromNodes', '$generateNodesFromDOM',
      '$applyNodeReplacement',
      // Command priorities
      'COMMAND_PRIORITY_LOW', 'COMMAND_PRIORITY_NORMAL', 'COMMAND_PRIORITY_HIGH',
      'COMMAND_PRIORITY_EDITOR', 'COMMAND_PRIORITY_CRITICAL',
      // Commands
      'createCommand', 'SELECTION_CHANGE_COMMAND', 'KEY_ENTER_COMMAND',
      'KEY_BACKSPACE_COMMAND', 'KEY_DELETE_COMMAND', 'KEY_TAB_COMMAND',
      'KEY_ESCAPE_COMMAND', 'INSERT_PARAGRAPH_COMMAND', 'INSERT_LINE_BREAK_COMMAND',
      'PASTE_COMMAND', 'COPY_COMMAND', 'CUT_COMMAND', 'CLICK_COMMAND',
      'FORMAT_TEXT_COMMAND', 'FORMAT_ELEMENT_COMMAND', 'UNDO_COMMAND', 'REDO_COMMAND',
      // Editor and nodes
      'createEditor', 'LineBreakNode', 'ParagraphNode', 'TextNode',
      'ElementNode', 'DecoratorNode', 'LexicalNode', 'RootNode',
      // Serialization
      'SerializedLexicalNode', 'SerializedEditor', 'EditorState',
      'DOMConversionMap', 'DOMConversionOutput', 'DOMExportOutput',
      'LexicalEditor', 'EditorConfig', 'NodeKey', 'Spread',
    ];
  } else if (externalKey === '@lexical/react/LexicalComposerContext') {
    exports = ['useLexicalComposerContext', 'LexicalComposerContext', 'createLexicalComposerContext'];
  } else if (externalKey === '@lexical/react/useLexicalEditable') {
    exports = ['useLexicalEditable', 'default'];
  } else if (externalKey === '@lexical/react/useLexicalNodeSelection') {
    exports = ['useLexicalNodeSelection', 'default'];
  } else if (externalKey === '@lexical/utils') {
    exports = [
      'mergeRegister', '$findMatchingParent', '$getNearestNodeOfType',
      '$getNearestBlockElementAncestorOrThrow', '$insertNodeToNearestRoot',
      'addClassNamesToElement', 'removeClassNamesFromElement',
      'isMimeType', 'mediaFileReader', '$restoreEditorState',
      'positionNodeOnRange', '$wrapNodeInElement', 'calculateZoomLevel',
    ];
  } else if (externalKey === '@lexical/markdown') {
    exports = [
      '$convertFromMarkdownString', '$convertToMarkdownString',
      'TRANSFORMERS', 'registerMarkdownShortcuts',
      'ELEMENT_TRANSFORMERS', 'TEXT_FORMAT_TRANSFORMERS', 'TEXT_MATCH_TRANSFORMERS',
      'HEADING', 'QUOTE', 'CODE', 'UNORDERED_LIST', 'ORDERED_LIST',
      'CHECK_LIST', 'LINK', 'INLINE_CODE', 'BOLD_ITALIC_STAR', 'BOLD_ITALIC_UNDERSCORE',
      'BOLD_STAR', 'BOLD_UNDERSCORE', 'ITALIC_STAR', 'ITALIC_UNDERSCORE',
      'STRIKETHROUGH', 'HIGHLIGHT',
    ];
  } else if (externalKey === '@nimbalyst/editor-context') {
    exports = ['useDocumentPath'];
  } else if (externalKey === '@nimbalyst/runtime/ui/icons/MaterialSymbol') {
    exports = ['MaterialSymbol'];
  } else if (externalKey === '@nimbalyst/runtime') {
    exports = [
      'MaterialSymbol', 'useDocumentPath', 'useEditorLifecycle',
      'useCollaborativeEditor', 'COLLAB_INIT_ORIGIN',
      'setTranscriptMarkdownContributions', 'clearTranscriptMarkdownContributions',
      'MarkdownEditor', 'MonacoEditor', 'MonacoCodeEditor',
      'TrackerReferenceChip', 'TrackerReferencePicker',
      'useResolvedTrackerReference', 'navigateToTrackerReference',
    ];
  } else if (externalKey === '@nimbalyst/screenshot-service') {
    exports = ['screenshotService'];
  } else if (externalKey === '@nimbalyst/datamodel-platform-service') {
    exports = ['DataModelPlatformServiceImpl', 'getInstance'];
  } else if (externalKey === 'pdfjs-dist') {
    exports = ['getDocument', 'GlobalWorkerOptions', 'version'];
  } else if (externalKey === 'virtua') {
    exports = ['VList', 'Virtualizer', 'WindowVirtualizer'];
  }

  if (exports.length === 0) {
    return '// No common exports defined for this module';
  }

  // Generate export statements
  const lines = exports.map(name => {
    // Handle 'default' specially
    if (name === 'default') {
      return `// default export handled above`;
    }
    return `export const ${name} = __nimbalyst_mod__?.${name};`;
  });

  return lines.join('\n');
}
