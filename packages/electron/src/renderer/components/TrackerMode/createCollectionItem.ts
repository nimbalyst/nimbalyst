/**
 * Create a collection (milestone / release) from a field surface.
 *
 * The Collection chip's picker lets a user name a collection that does not exist
 * yet. Item creation is Electron-only, so the runtime picker takes this as a
 * callback rather than reaching for `window.electronAPI` itself.
 *
 * Defaults come from the type's schema via `buildTrackerCreatePayload` — the same
 * id prefix, workflow status, and sharing defaults every other create surface
 * uses — so a collection created from a chip is indistinguishable from one
 * created in the tracker view.
 */

import {
  buildTrackerCreatePayload,
  formatTrackerValidationErrors,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import type { RelationshipCandidate } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/RelationshipFieldEditor';
import { createTrackerItem } from '../../services/localWikiTrackerRecords';

export async function createCollectionItem(params: {
  workspacePath: string;
  type: string;
  title: string;
}): Promise<RelationshipCandidate | null> {
  const { workspacePath, type, title } = params;

  const built = buildTrackerCreatePayload(type, { title }, { workspacePath });
  if (!built.ok) {
    throw new Error(formatTrackerValidationErrors(built.errors));
  }

  const result = await createTrackerItem(built.payload);
  if (!result.success) {
    throw new Error(result.error || 'Failed to create collection');
  }

  const created = result.item;
  return {
    itemId: created?.id ?? built.payload.id,
    title: created?.title ?? title,
    issueKey: created?.issueKey ?? undefined,
    trackerType: type,
  };
}
