/**
 * The desktop's Links section: the shared section (collab-client) reading the
 * local relationship index over IPC. Same props as before the section moved.
 */
import React, { useMemo } from 'react';
import { TrackerLinksSection as SharedTrackerLinksSection, type PageLinksSource, type TrackerPageLink } from '@nimbalyst/collab-client/trackers-ui/page';

export type { TrackerPageLink };

/** The links main indexed for this workspace: field relations, own body links and teammates'. */
export function desktopPageLinksSource(workspacePath: string): PageLinksSource {
  return {
    linksFor: async (itemId) => {
      const res = await window.electronAPI.invoke('document-service:tracker-item-links', { workspacePath, itemId });
      return res?.success && Array.isArray(res.links) ? (res.links as TrackerPageLink[]) : null;
    },
  };
}

interface TrackerLinksSectionProps {
  workspacePath?: string;
  itemId: string;
  itemType?: string;
  /** Bumped by the host after a save that may have re-indexed links. */
  revision?: number;
  onOpenItem?: (itemId: string) => void;
}

export const TrackerLinksSection: React.FC<TrackerLinksSectionProps> = ({ workspacePath, ...props }) => {
  const linksSource = useMemo(() => (workspacePath ? desktopPageLinksSource(workspacePath) : null), [workspacePath]);
  return <SharedTrackerLinksSection linksSource={linksSource} {...props} />;
};
