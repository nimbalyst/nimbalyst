import { useEffect, useState, memo, useRef } from 'react';
import type { LexicalEditor } from 'lexical';
import { FixedTabHeaderRegistry } from './FixedTabHeaderRegistry';
import type { FixedTabHeaderProvider, TabContext } from './types';
import './FixedTabHeader.css';

interface FixedTabHeaderContainerProps {
  filePath: string;
  fileName: string;
  editor?: LexicalEditor;
}

function FixedTabHeaderContainerComponent({
  filePath,
  fileName,
  editor,
}: FixedTabHeaderContainerProps) {
  const [providers, setProviders] = useState<FixedTabHeaderProvider[]>([]);
  const [updateTrigger, setUpdateTrigger] = useState(0);

  // Update providers when filePath, fileName, editor, or updateTrigger changes
  useEffect(() => {
    const context: TabContext = {
      filePath,
      fileName,
      editor,
    };

    const registry = FixedTabHeaderRegistry.getInstance();
    const activeProviders = registry.getProviders(context);
    setProviders(activeProviders);
  }, [filePath, fileName, editor, updateTrigger]);

  // Listen to editor updates to re-evaluate shouldRender (for dynamic conditions like $hasDiffNodes)
  // Use a ref to throttle updates and prevent re-rendering on every keystroke
  // Note: Only Lexical editors have registerUpdateListener
  useEffect(() => {
    if (!editor) return;

    // Check if this is a Lexical editor (has registerUpdateListener method)
    if (typeof (editor as any).registerUpdateListener !== 'function') {
      // Not a Lexical editor (probably Monaco), skip update listener
      return;
    }

    let timeoutId: NodeJS.Timeout | null = null;

    const unregister = editor.registerUpdateListener(() => {
      // Throttle re-evaluation to avoid constant re-renders
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => {
        setUpdateTrigger(prev => prev + 1);
        timeoutId = null;
      }, 100); // Wait 100ms after last edit before re-evaluating
    });

    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      unregister();
    };
  }, [editor]);

  if (providers.length === 0) {
    return null;
  }

  return (
    <div className="fixed-tab-header-container">
      {providers.map((provider) => {
        const Component = provider.component;
        return (
          <Component
            key={provider.id}
            filePath={filePath}
            fileName={fileName}
            editor={editor}
          />
        );
      })}
    </div>
  );
}

// Memoize to prevent re-renders when parent re-renders
// Re-render only when:
// 1. filePath or fileName changes (new file)
// 2. Editor transitions from undefined to defined (initial load)
// After that, never re-render - the editor instance is stable
export const FixedTabHeaderContainer = memo(FixedTabHeaderContainerComponent, (prev, next) => {
  // Always re-render if filePath or fileName changed
  if (prev.filePath !== next.filePath || prev.fileName !== next.fileName) {
    return false; // false = do re-render
  }

  // If editor is transitioning from undefined to defined, re-render
  if (!prev.editor && next.editor) {
    return false; // false = do re-render
  }

  // Otherwise, skip re-render (editor instance reference changes but it's the same logical editor)
  return true; // true = skip re-render
});
