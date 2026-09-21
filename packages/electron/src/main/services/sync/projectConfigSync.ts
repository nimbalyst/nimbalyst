import type { SyncProvider, SyncedSlashCommand } from '@nimbalyst/runtime/sync/types';
import type { ActionPrompt } from '../ActionPromptParser';
import { composeProjectConfig, toSyncedActionPrompts, type ProjectConfigSlices } from './projectConfigComposer';

export interface ProjectConfigSyncDependencies {
  getProvider(): SyncProvider | null;
  getEnabledProjects(): string[];
  isProjectEnabled(workspacePath: string): boolean;
  discoverCommands(workspacePath: string): Promise<SyncedSlashCommand[]>;
  discoverActions(workspacePath: string): Promise<ActionPrompt[]>;
  getGitRemoteHash(workspacePath: string): Promise<string | undefined>;
  subscribeChanges?(workspacePath: string, changed: () => void): Promise<() => void>;
  refreshWatchers?(workspacePath: string): Promise<void>;
  warn(message: string, error?: unknown): void;
}

/** Owns both slices of the whole-object config, independently of mounted composers. */
export function createProjectConfigSync(deps: ProjectConfigSyncDependencies) {
  const pending = new Map<string, { again: boolean; promise: Promise<void> }>();
  const subscriptions = new Map<string, { active: boolean; unsubscribe?: () => void }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let generation = 0;
  let observedProvider: SyncProvider | null = null;
  let unsubscribeReconnect: (() => void) | undefined;

  function prune(path: string): void {
    const subscription = subscriptions.get(path);
    if (subscription) { subscription.active = false; subscription.unsubscribe?.(); subscriptions.delete(path); }
    clearTimeout(timers.get(path));
    timers.delete(path);
    pending.delete(path);
  }

  function watch(path: string): void {
    if (subscriptions.has(path)) {
      // Missing optional global roots may have appeared since the last refresh.
      void deps.refreshWatchers?.(path).catch(error => deps.warn(`[SyncManager] Failed to refresh config watchers for ${path}; retrying on next refresh`, error));
      return;
    }
    if (!deps.subscribeChanges) return;
    const subscription = { active: true, unsubscribe: undefined as (() => void) | undefined };
    subscriptions.set(path, subscription);
    // Watcher setup runs independently of discovery/publication. A failed setup
    // is retried on the next refresh; it must not hold session/config sends up.
    void deps.subscribeChanges(path, () => {
      if (!subscription.active || !deps.isProjectEnabled(path)) return;
      clearTimeout(timers.get(path));
      timers.set(path, setTimeout(() => {
        timers.delete(path);
        if (subscription.active) void publish(path); // Next edit/join/reconnect retries failed sends.
      }, 500));
    }).then(unsubscribe => {
      if (subscription.active && deps.isProjectEnabled(path)) subscription.unsubscribe = unsubscribe;
      else unsubscribe();
    }).catch(error => {
      if (subscriptions.get(path) === subscription) subscriptions.delete(path);
      subscription.active = false;
      deps.warn(`[SyncManager] Failed to watch project config for ${path}; retrying on next refresh`, error);
    });
  }

  function manifests(commands: Array<{ name: string; description?: string; source: string }>): SyncedSlashCommand[] {
    return commands.map(({ name, description, source }) => ({
      name, description, source: source as SyncedSlashCommand['source'],
    }));
  }

  function setActions(path: string, slices: ProjectConfigSlices, actions: ActionPrompt[]): void {
    const projected = toSyncedActionPrompts(actions);
    if (projected.droppedForCount || projected.droppedForSize || projected.truncatedCount) {
      deps.warn(`[SyncManager] Mobile action prompts exceeded the sync budget for ${path}`, projected);
    }
    slices.actions = projected.actions;
    slices.lastActionsUpdate = Date.now();
  }

  function publish(path: string): Promise<void> {
    const provider = deps.getProvider();
    const started = generation;
    if (!provider?.syncProjectConfig || !deps.isProjectEnabled(path)) return Promise.resolve();
    const existing = pending.get(path);
    if (existing) { existing.again = true; return existing.promise; }
    const job = { again: false, promise: Promise.resolve() };
    const current = () => pending.get(path) === job && started === generation && deps.getProvider() === provider && deps.isProjectEnabled(path);
    const publishOnce = async () => {
      if (!current()) return;
      await provider.waitForIndexReady?.();
      if (!current()) return;
      const commands = await deps.discoverCommands(path);
      const actions = await deps.discoverActions(path);
      const slices: ProjectConfigSlices = { commands: manifests(commands), lastCommandsUpdate: Date.now(), actions: [], lastActionsUpdate: 0 };
      setActions(path, slices, actions);
      const gitRemoteHash = await deps.getGitRemoteHash(path);
      if (!current()) return;
      await provider.syncProjectConfig!(path, composeProjectConfig({ ...slices, gitRemoteHash }));
    };
    // One current publication plus one follow-up, regardless of how many
    // refreshes arrive while discovery, encryption or transport is waiting.
    job.promise = Promise.resolve().then(async () => {
      do {
        job.again = false;
        try { await publishOnce(); }
        catch (error) {
          // Next file edit, project enable, join or reconnect retries this slice.
          deps.warn(`[SyncManager] Failed to sync project config for ${path}`, error);
        }
      } while (job.again && current());
      if (pending.get(path) === job) pending.delete(path);
    });
    pending.set(path, job);
    return job.promise;
  }

  async function refresh(workspacePath?: string): Promise<void> {
    const provider = deps.getProvider();
    if (observedProvider !== provider) {
      unsubscribeReconnect?.();
      observedProvider = provider;
      const started = generation;
      unsubscribeReconnect = provider?.onConnectionGenerationChange?.(() => {
        // Reconnect is the retry for file changes that could not be published offline.
        if (started === generation && deps.getProvider() === provider) void refresh();
      });
    }
    for (const path of subscriptions.keys()) {
      if (!deps.isProjectEnabled(path)) prune(path);
    }
    const paths = [...new Set(workspacePath ? [workspacePath] : deps.getEnabledProjects())].filter(deps.isProjectEnabled);
    if (!provider) return;
    for (const path of paths) watch(path);
    await Promise.all(paths.map(publish));
  }

  function stop(): void {
    generation++;
    unsubscribeReconnect?.();
    unsubscribeReconnect = undefined;
    observedProvider = null;
    for (const path of subscriptions.keys()) prune(path);
    pending.clear();
  }

  return { refresh, stop };
}
