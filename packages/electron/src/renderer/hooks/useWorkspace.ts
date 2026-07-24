/**
 * useWorkspace - React hook bridge to WorkspaceManager
 */

import { useState, useEffect } from 'react';
import { workspaceManager } from '../services/WorkspaceManager';

export function useWorkspace() {
  const [, forceUpdate] = useState({});

  useEffect(() => {
    const unsubscribe = workspaceManager.subscribe(() => {
      forceUpdate({});
    });
    return unsubscribe;
  }, []);

  return workspaceManager;
}