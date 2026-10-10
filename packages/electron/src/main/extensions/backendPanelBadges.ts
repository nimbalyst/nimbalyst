/**
 * Host side of `ctx.services.panels.setGutterBadge` for backend modules.
 *
 * A fullscreen panel unmounts when the user leaves it, so only the backend
 * module sees background events (a new flag, a budget crossing). This lets the
 * module put a badge on its own panel's gutter button without the panel.
 *
 * Scope: the badge is keyed `<extensionId>.<panelId>` (the renderer's full
 * panel id) with the extension id taken from the calling module's runtime
 * context, and the panel id must be declared in that extension's own
 * manifest. A module therefore cannot touch another extension's panels.
 *
 * Delivery: every window receives `extension-panels:gutter-badge` with the
 * module's workspace; the renderer shows it only while that workspace is the
 * active one. The latest value per (workspace, panel) is also kept here so a
 * window that mounts after the module set it (app launch, a new window) can
 * replay it through `extension-panels:get-gutter-badges`. Badges a module set
 * are cleared when that module stops or crashes.
 *
 * No permission gate: a count or dot on the extension's own button reveals
 * nothing and reaches nothing outside the extension, the same capability its
 * panel already has through `host.setGutterBadge` without a permission.
 */
import * as path from 'path';
import * as fs from 'fs/promises';
import { BrowserWindow } from 'electron';
import type { PanelGutterBadgeTone } from '@nimbalyst/extension-sdk';
import { safeHandle } from '../utils/ipcRegistry';
import type { BackendRuntimeContext } from './extensionBackendRpc';

export const PANEL_GUTTER_BADGE_CHANNEL = 'extension-panels:gutter-badge';
export const GET_PANEL_GUTTER_BADGES_CHANNEL = 'extension-panels:get-gutter-badges';

/** Wire payload. `panelId` is the full `<extensionId>.<panelId>` id; `value: null` clears. */
export interface PanelGutterBadgeUpdate {
  workspacePath: string;
  panelId: string;
  value: number | null;
  tone: PanelGutterBadgeTone;
}

interface CachedBadge extends PanelGutterBadgeUpdate {
  extensionId: string;
  moduleId: string;
}

const badges = new Map<string, CachedBadge>();

function cacheKey(workspacePath: string, fullPanelId: string): string {
  return `${workspacePath}\u001f${fullPanelId}`;
}

async function readDeclaredPanelIds(extensionPath: string): Promise<Set<string>> {
  const raw = await fs.readFile(path.join(extensionPath, 'manifest.json'), 'utf-8');
  const panels = (JSON.parse(raw) as { contributions?: { panels?: Array<{ id?: unknown }> } })
    .contributions?.panels;
  return new Set(
    (Array.isArray(panels) ? panels : [])
      .map((p) => p?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  );
}

function broadcast(update: PanelGutterBadgeUpdate): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(PANEL_GUTTER_BADGE_CHANNEL, update);
  }
}

export async function setBackendPanelGutterBadge(
  ctx: Pick<BackendRuntimeContext, 'extensionId' | 'moduleId' | 'workspacePath' | 'extensionPath'>,
  panelId: unknown,
  value: unknown,
  tone: unknown
): Promise<void> {
  if (typeof panelId !== 'string' || !panelId) throw new Error('panelId is required');
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('value must be a finite number or null');
  }
  if (tone !== undefined && tone !== 'default' && tone !== 'warning') {
    throw new Error(`Invalid tone "${String(tone)}"`);
  }
  // Read at call time: badge updates are rare, and a dev rebuild can change
  // the manifest under a running module.
  if (!(await readDeclaredPanelIds(ctx.extensionPath)).has(panelId)) {
    throw new Error(`Panel "${panelId}" is not declared by extension ${ctx.extensionId}`);
  }
  const update: PanelGutterBadgeUpdate = {
    workspacePath: ctx.workspacePath,
    panelId: `${ctx.extensionId}.${panelId}`,
    value: value === null ? null : Math.max(0, Math.floor(value as number)),
    tone: tone ?? 'default',
  };
  const key = cacheKey(update.workspacePath, update.panelId);
  if (update.value === null) badges.delete(key);
  else badges.set(key, { ...update, extensionId: ctx.extensionId, moduleId: ctx.moduleId });
  broadcast(update);
}

/** Clear every badge the given module set, e.g. when it stops or crashes. */
export function clearBackendPanelGutterBadgesForModule(
  extensionId: string,
  moduleId: string,
  workspacePath: string
): void {
  for (const [key, badge] of badges) {
    if (badge.extensionId !== extensionId || badge.moduleId !== moduleId) continue;
    if (badge.workspacePath !== workspacePath) continue;
    badges.delete(key);
    broadcast({ workspacePath, panelId: badge.panelId, value: null, tone: badge.tone });
  }
}

/** Current badges, for a window that mounted after they were set. */
export function listBackendPanelGutterBadges(): PanelGutterBadgeUpdate[] {
  return [...badges.values()].map(({ workspacePath, panelId, value, tone }) => ({
    workspacePath,
    panelId,
    value,
    tone,
  }));
}

/** Idempotent (safeHandle skips a second registration). */
export function registerBackendPanelBadgeHandlers(): void {
  safeHandle(GET_PANEL_GUTTER_BADGES_CHANNEL, () => listBackendPanelGutterBadges());
}

/** Test-only. */
export function _resetBackendPanelGutterBadges(): void {
  badges.clear();
}
