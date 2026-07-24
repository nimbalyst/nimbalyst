import { useState, useCallback } from 'react';

export type SnapshotType = 'auto-save' | 'manual' | 'ai-diff' | 'pre-apply' | 'external-change' | 'ai-edit' | 'pre-edit' | 'incremental-approval' | 'auto';

export interface SnapshotMetadata {
  type?: string;
  baseMarkdownHash?: string;
  sessionId?: string;
  tagId?: string;
  status?: string;
  [key: string]: unknown;
}

export interface Snapshot {
  timestamp: string;
  type: SnapshotType;
  size: number;
  baseMarkdownHash: string;
  metadata?: SnapshotMetadata;
}

export function useHistory(filePath: string | null) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(false);

  const refreshSnapshots = useCallback(async () => {
    if (!filePath || !window.electronAPI?.history) return;

    setLoading(true);
    try {
      const list = await window.electronAPI.history.listSnapshots(filePath);
      setSnapshots(list);
    } finally {
      setLoading(false);
    }
  }, [filePath]);

  const createSnapshot = useCallback(async (
    state: string,
    type: SnapshotType,
    description?: string
  ) => {
    if (!filePath || !window.electronAPI?.history) return;

    setLoading(true);
    try {
      await window.electronAPI.history.createSnapshot(filePath, state, type, description);
      await refreshSnapshots();
    } finally {
      setLoading(false);
    }
  }, [filePath, refreshSnapshots]);

  const loadSnapshot = useCallback(async (timestamp: string): Promise<string | null> => {
    if (!filePath || !window.electronAPI?.history) return null;
    
    setLoading(true);
    try {
      return await window.electronAPI.history.loadSnapshot(filePath, timestamp);
    } finally {
      setLoading(false);
    }
  }, [filePath]);

  const deleteSnapshot = useCallback(async (timestamp: string) => {
    if (!filePath || !window.electronAPI?.history) return;

    setLoading(true);
    try {
      await window.electronAPI.history.deleteSnapshot(filePath, timestamp);
      await refreshSnapshots();
    } finally {
      setLoading(false);
    }
  }, [filePath, refreshSnapshots]);

  return {
    snapshots,
    loading,
    createSnapshot,
    refreshSnapshots,
    loadSnapshot,
    deleteSnapshot,
  };
}