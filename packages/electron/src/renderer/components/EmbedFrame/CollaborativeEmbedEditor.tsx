import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { EditorHost } from '@nimbalyst/runtime';

import type { CustomEditorRegistration } from '../CustomEditors/types';
import { useTheme } from '../../hooks/useTheme';
import {
  collaborativeEmbedProviderCache,
  collaborativeEmbedResourceKey,
  type CollaborativeEmbedProviderAcquisition,
  type CollaborativeEmbedProviderRequest,
} from '../../services/CollaborativeEmbedProviderCache';
import { buildCollabUri } from '../../utils/collabUri';
import { createCollabExtensionHost } from '../TabEditor/collabExtensionHost';

interface CollaborativeEmbedEditorProps {
  registration: CustomEditorRegistration;
  request: CollaborativeEmbedProviderRequest;
}

export const CollaborativeEmbedEditor: React.FC<
  CollaborativeEmbedEditorProps
> = ({ registration, request }) => {
  const { theme } = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const themeListeners = useRef(new Set<(nextTheme: string) => void>());
  const [acquisition, setAcquisition] =
    useState<CollaborativeEmbedProviderAcquisition | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    for (const listener of themeListeners.current) listener(theme);
  }, [theme]);

  // Acquire on the request's VALUE, not its identity. An equal-but-new request
  // object (a parent re-render) must not disconnect and rebuild a live child
  // room; only a genuinely different room or editor configuration should.
  const resourceKey = collaborativeEmbedResourceKey(request);
  const requestRef = useRef(request);
  requestRef.current = request;

  useEffect(() => {
    let cancelled = false;
    let acquired: CollaborativeEmbedProviderAcquisition | null = null;
    setAcquisition(null);
    setError(null);
    void collaborativeEmbedProviderCache.acquire(requestRef.current)
      .then(next => {
        if (cancelled) {
          next.release();
          return;
        }
        acquired = next;
        setAcquisition(next);
      })
      .catch(reason => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason : new Error(String(reason)));
        }
      });
    return () => {
      cancelled = true;
      acquired?.release();
    };
  }, [resourceKey]);

  const { orgId, documentId, title, workspacePath } = request;
  const host = useMemo<EditorHost | null>(() => {
    if (!acquisition) return null;
    const filePath = buildCollabUri(orgId, documentId);
    return createCollabExtensionHost({
      filePath,
      fileName: title,
      isActive: true,
      workspaceId: workspacePath,
      activeConfig: acquisition.resource.config,
      collaboration: acquisition.resource.collaboration,
      getTheme: () => themeRef.current,
      subscribeToThemeChanges: callback => {
        themeListeners.current.add(callback);
        return () => {
          themeListeners.current.delete(callback);
        };
      },
      embedded: true,
      readOnly: true,
    });
  }, [acquisition, documentId, orgId, title, workspacePath]);

  if (error) {
    return (
      <div
        className="embed-frame__body--placeholder"
        data-testid="collaborative-embed-error"
      >
        <p>Could not load shared embed</p>
        <code>{error.message}</code>
      </div>
    );
  }

  if (!host) {
    return (
      <div
        className="embed-frame__loading"
        data-testid="collaborative-embed-loading"
      >
        Loading shared embed...
      </div>
    );
  }

  const ExtensionComponent = registration.component;
  return <ExtensionComponent host={host} />;
};
