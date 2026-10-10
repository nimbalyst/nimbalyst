/**
 * Panel-wide state: the roster snapshot, which member is selected, which
 * session the desk is reading, and the backend client.
 *
 * The backend cannot push to the panel, so the roster is polled and compared
 * by `revision`; every other view refetches when the revision moves. Actions
 * call `refresh()` so their effect shows without waiting for the next poll.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { PanelHost } from '@nimbalyst/extension-sdk';
import type { CrewRosterSnapshot } from '../shared/types';
import { createCrewClient, type CrewClient } from './crewClient';
import { crewGutterBadge } from './crewDeskModel';
import { errorMessage } from './crewFormat';

const ROSTER_POLL_MS = 5_000;
const SELECTED_MEMBER_KEY = 'selectedMember';

export type CrewRosterState =
  | { status: 'loading' }
  | { status: 'ready'; roster: CrewRosterSnapshot }
  | { status: 'error'; error: string; roster?: CrewRosterSnapshot };

interface CrewContextValue {
  host: PanelHost;
  client: CrewClient;
  rosterState: CrewRosterState;
  roster: CrewRosterSnapshot | null;
  /** Bumps whenever the backend's revision changes; views refetch on it. */
  revision: number;
  refresh: () => Promise<void>;
  selectedSlug: string | null;
  select: (slug: string | null) => void;
  /** A session the desk shows instead of the current chapter (an earlier chapter, a delegated session). */
  viewingSessionId: string | null;
  viewSession: (slug: string, sessionId: string | null) => void;
  hireOpen: boolean;
  setHireOpen: (open: boolean) => void;
}

const CrewContext = createContext<CrewContextValue | null>(null);

export function useCrew(): CrewContextValue {
  const value = useContext(CrewContext);
  if (!value) throw new Error('useCrew must be used inside CrewProvider');
  return value;
}

export function CrewProvider({ host, children }: { host: PanelHost; children: ReactNode }) {
  const client = useMemo(() => createCrewClient(host), [host]);
  const [rosterState, setRosterState] = useState<CrewRosterState>({ status: 'loading' });
  const [selectedSlug, setSelectedSlug] = useState<string | null>(() => host.storage.get<string>(SELECTED_MEMBER_KEY) ?? null);
  const [viewingSessionId, setViewingSessionId] = useState<string | null>(null);
  const [hireOpen, setHireOpen] = useState(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const lastRevision = useRef<number | null>(null);

  const refresh = useCallback((): Promise<void> => {
    // Coalesce: a poll landing during an action's refresh reuses that request.
    if (inFlight.current) return inFlight.current;
    const request = client.call('roster', {})
      .then((roster) => {
        if (roster.revision === lastRevision.current) {
          // Unchanged; only clear a previous error.
          setRosterState((current) => (current.status === 'ready' ? current : { status: 'ready', roster }));
          return;
        }
        lastRevision.current = roster.revision;
        setRosterState({ status: 'ready', roster });
      })
      .catch((err) => {
        setRosterState((current) => ({
          status: 'error',
          error: errorMessage(err),
          roster: current.status === 'loading' ? undefined : current.roster,
        }));
      })
      .finally(() => { inFlight.current = null; });
    inFlight.current = request;
    return request;
  }, [client]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, ROSTER_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const select = useCallback((slug: string | null) => {
    setSelectedSlug(slug);
    setViewingSessionId(null);
    void host.storage.set(SELECTED_MEMBER_KEY, slug);
  }, [host]);

  const viewSession = useCallback((slug: string, sessionId: string | null) => {
    setSelectedSlug(slug);
    setViewingSessionId(sessionId);
    void host.storage.set(SELECTED_MEMBER_KEY, slug);
  }, [host]);

  const roster = rosterState.status === 'loading' ? null : rosterState.roster ?? null;

  // The host keeps this after the panel unmounts, but it only refreshes while
  // the panel is open: nothing polls the roster when Crew is not the visible mode.
  useEffect(() => {
    if (!roster) return;
    const badge = crewGutterBadge(roster);
    host.setGutterBadge(badge.value, { tone: badge.tone });
  }, [host, roster]);

  const value = useMemo<CrewContextValue>(() => ({
    host,
    client,
    rosterState,
    roster,
    revision: roster?.revision ?? -1,
    refresh,
    selectedSlug,
    select,
    viewingSessionId,
    viewSession,
    hireOpen,
    setHireOpen,
  }), [host, client, rosterState, roster, refresh, selectedSlug, select, viewingSessionId, viewSession, hireOpen]);

  return <CrewContext.Provider value={value}>{children}</CrewContext.Provider>;
}

/**
 * Run a backend action with busy/error state, then refresh the roster. The
 * error text is the backend's message, which is written for the user.
 */
export function useCrewAction() {
  const { refresh } = useCrew();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const run = useCallback(async <T,>(label: string, action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(label);
    setError(null);
    try {
      const result = await action();
      void refresh();
      return result;
    } catch (err) {
      if (mounted.current) setError(errorMessage(err));
      return undefined;
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, [refresh]);

  return { busy, error, run, clearError: () => setError(null) };
}

/**
 * Fetch something that depends on the roster revision (member detail, the
 * feed, notes). Keeps the last good value across refetches so the view never
 * flashes back to "Loading".
 */
export function useCrewQuery<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const { revision } = useCrew();
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((data) => { if (!cancelled) setState({ data, error: null }); })
      .catch((err) => { if (!cancelled) setState((current) => ({ data: current.data, error: errorMessage(err) })); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, tick, ...deps]);

  return { ...state, reload: () => setTick((n) => n + 1) };
}
