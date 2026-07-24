import { useState, useCallback, useEffect } from 'react';

export type SessionType = 'ai-diff' | 'compare' | 'review';
export type SessionStatus = 'active' | 'paused' | 'conflict' | 'applied';
export type ResolutionType = 'reload' | 'merge' | 'overwrite';

export interface SessionMetadata {
  id: string;
  type: SessionType;
  filePath: string;
  created: string;
  lastModified: string;
  baseMarkdownHash: string;
  currentMarkdownHash?: string;
  status: SessionStatus;
  source?: any;
  stats?: {
    totalDiffs?: number;
    appliedDiffs?: number;
    rejectedDiffs?: number;
  };
}

export interface Session {
  id: string;
  metadata: SessionMetadata;
  state?: string;
}

export interface ConflictStatus {
  hasConflict: boolean;
  reason?: 'file-changed' | 'base-mismatch';
  resolution?: ResolutionType;
}

export function useSession(filePath: string | null) {
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(false);

  // Load active session when file path changes
  useEffect(() => {
    if (filePath && window.electronAPI?.session) {
      loadActiveSession();
    } else {
      setActiveSession(null);
    }
  }, [filePath]);

  const loadActiveSession = useCallback(async () => {
    if (!filePath || !window.electronAPI?.session) return;
    
    setLoading(true);
    try {
      const session = await window.electronAPI.session.getActive(filePath);
      setActiveSession(session);
    } finally {
      setLoading(false);
    }
  }, [filePath]);

  const createSession = useCallback(async (
    type: SessionType,
    source?: any
  ): Promise<Session | null> => {
    if (!filePath || !window.electronAPI?.session) return null;
    
    setLoading(true);
    try {
      const session = await window.electronAPI.session.create(filePath, type, source);
      setActiveSession(session);
      return session;
    } finally {
      setLoading(false);
    }
  }, [filePath]);

  const loadSession = useCallback(async (sessionId: string): Promise<Session | null> => {
    if (!window.electronAPI?.session) return null;
    
    setLoading(true);
    try {
      const session = await window.electronAPI.session.load(sessionId);
      setActiveSession(session);
      return session;
    } finally {
      setLoading(false);
    }
  }, []);

  const saveSession = useCallback(async (session: Session) => {
    if (!window.electronAPI?.session) return;
    
    setLoading(true);
    try {
      await window.electronAPI.session.save(session);
      setActiveSession(session);
    } finally {
      setLoading(false);
    }
  }, []);

  const deleteSession = useCallback(async (sessionId: string) => {
    if (!window.electronAPI?.session) return;
    
    setLoading(true);
    try {
      await window.electronAPI.session.delete(sessionId);
      if (activeSession?.id === sessionId) {
        setActiveSession(null);
      }
    } finally {
      setLoading(false);
    }
  }, [activeSession]);

  const checkConflicts = useCallback(async (
    currentMarkdownHash: string
  ): Promise<ConflictStatus | null> => {
    if (!activeSession || !window.electronAPI?.session) return null;
    
    return await window.electronAPI.session.checkConflicts(activeSession, currentMarkdownHash);
  }, [activeSession]);

  const resolveConflict = useCallback(async (
    resolution: ResolutionType,
    newBaseHash?: string
  ) => {
    if (!activeSession || !window.electronAPI?.session) return;
    
    setLoading(true);
    try {
      await window.electronAPI.session.resolveConflict(activeSession, resolution, newBaseHash);
      await loadActiveSession();
    } finally {
      setLoading(false);
    }
  }, [activeSession, loadActiveSession]);

  const createCheckpoint = useCallback(async (state: string) => {
    if (!activeSession || !window.electronAPI?.session) return;
    
    await window.electronAPI.session.createCheckpoint(activeSession.id, state);
  }, [activeSession]);

  return {
    activeSession,
    loading,
    createSession,
    loadSession,
    saveSession,
    deleteSession,
    checkConflicts,
    resolveConflict,
    createCheckpoint,
    loadActiveSession,
  };
}