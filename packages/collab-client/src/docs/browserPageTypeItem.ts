/**
 * The tracker item Set type creates in a browser: the desktop's create payload
 * (schema defaults, self-identifier fields, validation) as the browser data
 * source's create input. The page body rides as `description`, which that
 * data source writes into the item's body room before the item goes out.
 */
import { buildTrackerCreatePayload, formatTrackerValidationErrors } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerCreatePayload';
import type { TrackerCreateItemInput } from '../trackers/dataSource';

export interface BrowserPageTypeItemRequest {
  typeId: string;
  title: string;
  markdown: string;
  /** The browser data source's workspace path for the project. */
  workspace: string;
}

/** Throws when the type cannot take the item (unknown, not creatable, invalid). */
export function browserPageTypeItemInput(request: BrowserPageTypeItemRequest): TrackerCreateItemInput {
  const built = buildTrackerCreatePayload(request.typeId, { title: request.title }, { workspacePath: request.workspace });
  if (!built.ok) throw new Error(formatTrackerValidationErrors(built.errors));
  const { payload } = built;
  return {
    id: payload.id,
    type: payload.type,
    title: payload.title,
    status: payload.status,
    priority: payload.priority,
    workspace: payload.workspace,
    // Untrimmed: the read-back compares against the page text as copied.
    ...(request.markdown.trim() ? { description: request.markdown } : {}),
    ...(payload.owner ? { owner: payload.owner } : {}),
    ...(payload.tags ? { tags: payload.tags } : {}),
    // The page was already the team's, so a draft-by-default type still
    // publishes it, as on the desktop.
    customFields: {
      ...payload.customFields,
      ...(payload.draftByDefault ? { share: { status: 'team', body: 'team' } } : {}),
    },
    sharing: 'team',
  };
}
