/**
 * Register the tracker-reference node and its markdown transformer through the
 * shared reference-node registration, plus the renderer-only live chip and the
 * relationship index its preview card lists connections from.
 */

import {
  setTrackerReferenceLinksSource,
  setTrackerReferenceNodeRenderer,
  TrackerReferenceChip,
} from '@nimbalyst/runtime/plugins/TrackerLinkPlugin';
import { registerTrackerReferenceContributions } from '@nimbalyst/runtime/plugins/referenceNodeContributions';
import { store } from '@nimbalyst/runtime/store';
import { groupTrackerPageLinks } from '@nimbalyst/collab-client/trackers-ui/page';

import { activeWorkspacePathAtom } from '../store/atoms/openProjects';
import { desktopPageLinksSource } from '../components/TrackerMode/TrackerLinksSection';

export function registerTrackerLinkPlugin(): void {
  setTrackerReferenceNodeRenderer(TrackerReferenceChip);
  registerTrackerReferenceContributions();
  setTrackerReferenceLinksSource({
    linkGroupsFor: async (itemId, itemType) => {
      const workspacePath = store.get(activeWorkspacePathAtom);
      if (!workspacePath) return null;
      const links = await desktopPageLinksSource(workspacePath).linksFor(itemId);
      if (!links) return null;
      return groupTrackerPageLinks(links, itemType).map(group => ({
        label: group.label,
        items: group.pages.map(({ itemId: id, title, typeId }) => ({ itemId: id, title, typeId })),
      }));
    },
  });
}
