/**
 * DocumentHeaderContainer - Renders all registered document headers
 *
 * This component:
 * - Queries the DocumentHeaderRegistry for matching providers
 * - Renders all matching header components
 * - Passes document context to each header
 */

import React, { useMemo, useEffect, useCallback } from 'react';
import { DocumentHeaderRegistry } from './DocumentHeaderRegistry';
import type { DocumentHeaderComponentProps } from './DocumentHeaderRegistry';

interface DocumentHeaderContainerProps {
  filePath: string;
  fileName: string;
  /** Callback to get current content from the editor. Called on mount and when providers need fresh content. */
  getContent: () => string;
  /** Version counter that increments when content changes externally (e.g., file watcher, AI edit). */
  contentVersion?: number;
  onContentChange?: (newContent: string) => void;
  editor?: any;
}

export const DocumentHeaderContainer: React.FC<DocumentHeaderContainerProps> = ({
  filePath,
  fileName,
  getContent,
  contentVersion = 0,
  onContentChange,
  editor,
}) => {
  // Track content only for provider matching - components get fresh content via getContent
  const [contentForMatching, setContentForMatching] = React.useState(() => getContent());
  // Local version counter that combines parent's contentVersion with our own updates
  const [localVersion, setLocalVersion] = React.useState(0);

  // Re-query content after a short delay to handle the case where the editor
  // hasn't provided its getContent function yet on first render.
  React.useEffect(() => {
    const timer = setTimeout(() => {
      const newContent = getContent();
      if (newContent) {
        setContentForMatching(prev => {
          if (prev !== newContent) {
            // Content changed - increment local version so children re-read
            setLocalVersion(v => v + 1);
            return newContent;
          }
          return prev;
        });
      }
    }, 50);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update content for matching when parent version changes (external content update)
  React.useEffect(() => {
    if (contentVersion > 0) {
      const newContent = getContent();
      setContentForMatching(newContent);
      setLocalVersion(v => v + 1);
    }
  }, [contentVersion, getContent]);

  // Effective version combines parent and local
  const effectiveVersion = contentVersion + localVersion;

  // Get matching providers based on content structure (frontmatter detection) and file path
  const providers = useMemo(() => {
    return DocumentHeaderRegistry.getProviders(contentForMatching, filePath);
  }, [contentForMatching, filePath]);

  // Wrap onContentChange to also bump localVersion so child headers
  // re-parse their state after making changes via the header controls
  const handleContentChange = useCallback((newContent: string) => {
    if (onContentChange) {
      onContentChange(newContent);
      // Bump local version so children re-read content on next render
      setLocalVersion(v => v + 1);
    }
  }, [onContentChange]);

  // Expose onContentChange handler globally for commands to access
  useEffect(() => {
    if (onContentChange) {
      (window as any).__documentContentChangeHandler = onContentChange;
    }
    return () => {
      delete (window as any).__documentContentChangeHandler;
    };
  }, [onContentChange]);

  if (providers.length === 0) {
    return null;
  }

  const componentProps: DocumentHeaderComponentProps = {
    filePath,
    fileName,
    getContent,
    contentVersion: effectiveVersion,
    onContentChange: handleContentChange,
    editor,
  };

  return (
    <div className="document-header-container w-full bg-[var(--nim-bg)] border-b border-[var(--nim-border)]">
      {providers.map(provider => {
        const Component = provider.component;
        return <Component key={provider.id} {...componentProps} />;
      })}
    </div>
  );
};
