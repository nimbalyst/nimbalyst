/**
 * Create a collection (milestone / release) from a field surface.
 *
 * The Collection chip's picker lets a user name a collection that does not exist
 * yet. Item creation is Electron-only, so the runtime picker takes this as a
 * callback rather than reaching for `window.electronAPI` itself.
 *
 * Defaults come from the type's schema — the same id prefix, workflow status,
 * and sync mode the quick-add path uses — so a collection created from a chip is
 * indistinguishable from one created in the tracker view.
 */

import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import type { RelationshipCandidate } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/RelationshipFieldEditor';

export async function createCollectionItem(params: {
  workspacePath: string;
  type: string;
  title: string;
}): Promise<RelationshipCandidate | null> {
  const { workspacePath, type, title } = params;
  const model = globalRegistry.get(type);
  if (model?.creatable === false) {
    throw new Error(`Cannot create items of type "${type}"`);
  }

  const prefix = model?.idPrefix || type.substring(0, 3);
  const id = `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`;

  const statusFieldName = model?.roles?.workflowStatus ?? 'status';
  const statusField = model?.fields.find((f) => f.name === statusFieldName);
  const status = (statusField?.default as string) || 'to-do';

  const result = await window.electronAPI.documentService.createTrackerItem({
    id,
    type,
    title,
    status,
    priority: 'medium',
    workspace: workspacePath,
    syncMode: model?.sync?.mode || 'local',
  });

  if (!result.success) {
    throw new Error(result.error || 'Failed to create collection');
  }

  const created = result.item;
  return {
    itemId: created?.id ?? id,
    title: created?.title ?? title,
    issueKey: created?.issueKey ?? undefined,
    trackerType: type,
  };
}
