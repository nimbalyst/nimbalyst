import { BrowserWindow } from 'electron';
import { generateKeyBetween, generateNKeysBetween } from '@nimbalyst/runtime/utils/fractionalIndex';
import {
  compareTrackerNavigationEntries,
  isTrackerNavigationEntry,
  type TrackerNavigationEntry,
  type TrackerNavigationFolder,
  type TrackerTypePlacement,
} from '@nimbalyst/runtime/sync';
import { safeHandle } from '../utils/ipcRegistry';
import {
  applyRemoteTrackerNavigationEntry,
  listTrackerNavigationEntries,
  removeTrackerNavigationEntry,
  upsertTrackerNavigationEntry,
  type ApplyRemoteNavigationResult,
} from './tracker/trackerNavigationStore';

let initialized = false;
let flushNavigation: ((workspacePath: string) => void | Promise<void>) | null = null;

export function registerTrackerNavigationFlushHandler(
  handler: (workspacePath: string) => void | Promise<void>,
): void {
  flushNavigation = handler;
}

function requestNavigationFlush(workspacePath: string): void {
  if (flushNavigation) void flushNavigation(workspacePath);
}

function notifyNavigationChanged(workspacePath: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('tracker-navigation:changed', { workspacePath });
  }
}

function normalizeEntry(entry: TrackerNavigationEntry): TrackerNavigationEntry {
  if (entry.kind === 'folder') {
    return { ...entry, name: entry.name.trim().slice(0, 120) };
  }
  return entry;
}

async function assertLocalFolderExists(workspacePath: string, folderId: string | null): Promise<void> {
  if (folderId === null) return;
  const entries = await listTrackerNavigationEntries(workspacePath);
  if (!entries.some((entry) => entry.kind === 'folder' && entry.folderId === folderId)) {
    throw new Error(`Unknown tracker folder '${folderId}'`);
  }
}

async function normalizeLongSortKeys(
  workspacePath: string,
  changedEntry: TrackerNavigationEntry,
): Promise<void> {
  if (changedEntry.sortKey.length <= 64) return;
  const entries = await listTrackerNavigationEntries(workspacePath);
  const siblings = entries
    .filter((entry) => changedEntry.kind === 'folder'
      ? entry.kind === 'folder'
      : entry.kind === 'type-placement' && entry.folderId === changedEntry.folderId)
    .sort(compareTrackerNavigationEntries);
  const keys = generateNKeysBetween(null, null, siblings.length);
  for (let index = 0; index < siblings.length; index += 1) {
    if (siblings[index].sortKey === keys[index]) continue;
    await upsertTrackerNavigationEntry(workspacePath, { ...siblings[index], sortKey: keys[index] });
  }
}

export async function saveWorkspaceTrackerNavigationEntry(
  workspacePath: string,
  input: TrackerNavigationEntry,
): Promise<TrackerNavigationEntry[]> {
  if (!workspacePath) throw new Error('workspacePath is required');
  const entry = normalizeEntry(input);
  if (!isTrackerNavigationEntry(entry)) throw new Error('Invalid tracker navigation entry');
  if (entry.kind === 'type-placement') await assertLocalFolderExists(workspacePath, entry.folderId);
  await upsertTrackerNavigationEntry(workspacePath, entry);
  await normalizeLongSortKeys(workspacePath, entry);
  notifyNavigationChanged(workspacePath);
  requestNavigationFlush(workspacePath);
  return listTrackerNavigationEntries(workspacePath);
}

export async function deleteWorkspaceTrackerFolder(
  workspacePath: string,
  folderId: string,
): Promise<TrackerNavigationEntry[]> {
  if (!workspacePath || !folderId) throw new Error('workspacePath and folderId are required');
  const entries = await listTrackerNavigationEntries(workspacePath);
  const folderEntryId = `folder:${folderId}`;
  if (!entries.some((entry) => entry.entryId === folderEntryId && entry.kind === 'folder')) {
    return entries;
  }

  const rootPlacements = entries
    .filter((entry): entry is TrackerTypePlacement => entry.kind === 'type-placement' && entry.folderId === null)
    .sort(compareTrackerNavigationEntries);
  let lastKey = rootPlacements.at(-1)?.sortKey ?? null;
  const members = entries
    .filter((entry): entry is TrackerTypePlacement => entry.kind === 'type-placement' && entry.folderId === folderId)
    .sort(compareTrackerNavigationEntries);
  for (const member of members) {
    const sortKey = generateKeyBetween(lastKey, null);
    await upsertTrackerNavigationEntry(workspacePath, { ...member, folderId: null, sortKey });
    lastKey = sortKey;
  }
  await removeTrackerNavigationEntry(workspacePath, folderEntryId);
  notifyNavigationChanged(workspacePath);
  requestNavigationFlush(workspacePath);
  return listTrackerNavigationEntries(workspacePath);
}

export async function ensureWorkspaceTrackerTypePlacements(
  workspacePath: string,
  trackerTypes: string[],
): Promise<TrackerNavigationEntry[]> {
  if (!workspacePath) throw new Error('workspacePath is required');
  const entries = await listTrackerNavigationEntries(workspacePath);
  const placed = new Set(
    entries
      .filter((entry): entry is TrackerTypePlacement => entry.kind === 'type-placement')
      .map((entry) => entry.trackerType),
  );
  const rootEntries = entries
    .filter((entry) => entry.kind === 'type-placement' && entry.folderId === null)
    .sort(compareTrackerNavigationEntries);
  let lastKey = rootEntries.at(-1)?.sortKey ?? null;
  let changed = false;
  for (const trackerType of trackerTypes) {
    if (!trackerType || placed.has(trackerType)) continue;
    const sortKey = generateKeyBetween(lastKey, null);
    await upsertTrackerNavigationEntry(workspacePath, {
      entryId: `type:${trackerType}`,
      kind: 'type-placement',
      trackerType,
      folderId: null,
      sortKey,
    });
    lastKey = sortKey;
    changed = true;
  }
  if (changed) notifyNavigationChanged(workspacePath);
  if (changed) requestNavigationFlush(workspacePath);
  return changed ? listTrackerNavigationEntries(workspacePath) : entries;
}

export async function applyRemoteWorkspaceTrackerNavigationEntry(
  workspacePath: string,
  def: { entryId: string; payload: string | null; syncId: number },
): Promise<ApplyRemoteNavigationResult> {
  const result = await applyRemoteTrackerNavigationEntry(workspacePath, def);
  if (result.applied) notifyNavigationChanged(workspacePath);
  return result;
}

export function initTrackerNavigationService(): void {
  if (initialized) return;
  initialized = true;
  safeHandle('tracker-navigation:list', async (_event, workspacePath: string) => {
    return listTrackerNavigationEntries(workspacePath);
  });
  safeHandle('tracker-navigation:save', async (_event, workspacePath: string, entry: TrackerNavigationEntry) => {
    return saveWorkspaceTrackerNavigationEntry(workspacePath, entry);
  });
  safeHandle('tracker-navigation:delete-folder', async (_event, workspacePath: string, folderId: string) => {
    return deleteWorkspaceTrackerFolder(workspacePath, folderId);
  });
  safeHandle('tracker-navigation:ensure-types', async (_event, workspacePath: string, trackerTypes: string[]) => {
    return ensureWorkspaceTrackerTypePlacements(workspacePath, trackerTypes);
  });
}

export type { TrackerNavigationEntry, TrackerNavigationFolder, TrackerTypePlacement };
