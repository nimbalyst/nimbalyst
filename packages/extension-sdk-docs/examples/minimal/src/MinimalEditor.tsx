import React, { useRef, useReducer } from 'react';
import { useEditorLifecycle } from '@nimbalyst/extension-sdk';
import type { EditorHostProps } from '@nimbalyst/extension-sdk';

/**
 * A minimal custom editor component.
 *
 * Uses the useEditorLifecycle hook to handle all lifecycle concerns:
 * - Loading content from disk
 * - Saving when the host requests it (autosave / Cmd+S)
 * - Echo detection (ignoring file changes from our own saves)
 * - Reloading when the file changes externally
 * - Theme tracking
 */
export function MinimalEditor({ host }: EditorHostProps) {
  const textRef = useRef('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [, forceRender] = useReducer((x) => x + 1, 0);

  const { isLoading, error, markDirty } = useEditorLifecycle(host, {
    applyContent: (content: string) => {
      textRef.current = content;
      if (textareaRef.current) {
        textareaRef.current.value = content;
      }
      forceRender();
    },
    getCurrentContent: () => textRef.current,
  });

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    textRef.current = e.target.value;
    markDirty();
  };

  if (error) {
    return <div style={{ padding: '16px' }}>Error: {error.message}</div>;
  }

  if (isLoading) {
    return <div style={{ padding: '16px' }}>Loading...</div>;
  }

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: '16px',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          marginBottom: '12px',
          color: 'var(--nim-text-muted)',
          fontSize: '12px',
        }}
      >
        Editing: {host.filePath}
      </div>
      <textarea
        ref={textareaRef}
        defaultValue={textRef.current}
        onChange={handleChange}
        placeholder="Start typing..."
        style={{
          flex: 1,
          width: '100%',
          padding: '12px',
          fontSize: '14px',
          fontFamily: 'monospace',
          backgroundColor: 'var(--nim-bg-secondary)',
          color: 'var(--nim-text)',
          border: '1px solid var(--nim-border)',
          borderRadius: '4px',
          resize: 'none',
          outline: 'none',
        }}
      />
    </div>
  );
}
