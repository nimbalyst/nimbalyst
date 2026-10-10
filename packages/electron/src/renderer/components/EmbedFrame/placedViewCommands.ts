/**
 * Publishes the slash menu's entries for placing a view in a page (built by
 * the runtime's `buildPlacedViewCommandEntries`, shared with the browser
 * editor), republished when the project's types change.
 *
 * The inserted link is a console link for the page's own scope (Decision 23):
 * the insert command reads the page's document path and asks
 * `placedViewScopeForDocument` here.
 */

import { setExtensionContributions } from '@nimbalyst/runtime/editor/extensions/extensionContributionsStore';
import { setExtensionLexicalExtension } from '@nimbalyst/runtime/editor/extensions/extensionLexicalExtensionsStore';
import { PlacedViewInsertExtension, setPlacedViewScopeResolver } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/placedViewInsert';
import { buildPlacedViewCommandEntries } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/placedViewCommandEntries';
import type { PlacedViewScope } from '@nimbalyst/runtime/core/placedViewUrl';
import { store } from '@nimbalyst/runtime/store';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import type { PlacedViewEmbedProps } from '@nimbalyst/collab-client/trackers-ui/embed';
import { activeCollabScopeAtom } from '../../store/atoms/collabDocuments';
import { isTeamTrackerSharing } from '../Settings/panels/trackerConfigUpgrade';

type Lane = 'team' | 'personal';
type PlacedViewReach = NonNullable<PlacedViewEmbedProps['reach']>;

export interface PlacedViewScopeLookups {
  /** The team project the window's Pages show, or null with no team. */
  team: { orgId: string; projectId: string } | null;
  itemLane(itemId: string): Lane;
  typeLane(typeId: string): Lane;
}

/**
 * The scope a page's placed views link under: a team page (shared document,
 * team typed page, team type page) names the team project; a Personal page,
 * Personal typed page or workspace file is `local`. Undefined when the page
 * is unknown or is the team's but no team project is open, so the insert
 * falls back to the app link rather than naming the wrong scope.
 */
export function placedViewScopeForDocument(path: string | null, lookups: PlacedViewScopeLookups): PlacedViewScope | undefined {
  if (!path) return undefined;
  const lane: Lane = path.startsWith('personal://') ? 'personal'
    : path.startsWith('collab://') ? 'team'
    : path.startsWith('tracker://') ? lookups.itemLane(path.slice('tracker://'.length))
    : path.startsWith('type://') ? lookups.typeLane(path.slice('type://'.length))
    : 'personal';
  if (lane === 'personal') return 'local';
  return lookups.team ?? undefined;
}

/**
 * What a placed view on the page at `path` may draw from this window's items:
 * the window's team project, and `local` views only on a page of the author's
 * own (a local link on a team page would show each reader their own items).
 * An unknown page reaches `local` only in a window with no team.
 */
export function placedViewReachForDocument(path: string | null, lookups: PlacedViewScopeLookups): PlacedViewReach {
  const pageScope = placedViewScopeForDocument(path, lookups);
  return {
    team: lookups.team,
    local: pageScope === 'local' || (pageScope === undefined && lookups.team === null),
  };
}

export function windowPlacedViewReach(path: string | null): PlacedViewReach {
  return placedViewReachForDocument(path, windowScopeLookups());
}

const typeLane = (typeId: string): Lane => {
  const model = globalRegistry.get(typeId);
  return model && isTeamTrackerSharing(model.sharing ?? 'personal') ? 'team' : 'personal';
};

function windowScopeLookups(): PlacedViewScopeLookups {
  const scope = store.get(activeCollabScopeAtom);
  const projectId = scope?.indexConfig.teamProjectId;
  return {
    team: scope && projectId ? { orgId: scope.orgId, projectId } : null,
    itemLane: (itemId) => {
      const record = store.get(trackerItemsMapAtom).get(itemId);
      return record ? typeLane(record.primaryType) : 'personal';
    },
    typeLane,
  };
}

const SOURCE = 'placed-view-embed';

export function registerPlacedViewCommands(): () => void {
  setExtensionLexicalExtension(SOURCE, PlacedViewInsertExtension);
  setPlacedViewScopeResolver((path) => placedViewScopeForDocument(path, windowScopeLookups()));
  const publish = () => {
    // The same entries the browser editor builds from its host's types.
    setExtensionContributions(SOURCE, { userCommands: buildPlacedViewCommandEntries(globalRegistry.getListed()) });
  };
  publish();
  return globalRegistry.onChange(publish);
}
