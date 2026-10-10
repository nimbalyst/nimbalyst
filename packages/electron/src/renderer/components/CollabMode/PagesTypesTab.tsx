/**
 * A Pages section's Types as a desktop tab (`virtual://pages-types/<lane>`):
 * the section's types as a map or a table over the tracker atoms, each type
 * opening its type page, and "New type..." opening the New type dialog with
 * the desktop's define-type write. A section has one Types tab, so the view it
 * shows is kept per section and survives the tab navigating away and back.
 */

import React from 'react';
import { atom, useAtom, useAtomValue, type PrimitiveAtom } from 'jotai';
import { TrackersUIProvider } from '@nimbalyst/collab-client/trackers-ui';
import { PagesTypesView, type PagesTypesViewMode } from '@nimbalyst/collab-client/trackers-ui/page';
import { NewTypeDialog } from '@nimbalyst/collab-client/docs-ui/setPageType';
import { useCollabTypeResolver } from './useCollabTypeResolver';
import { useDefineTrackerType } from './useDefineTrackerType';
import { PagesSectionUnavailable, usePagesSectionData, type PagesSectionData, type PagesSectionTabProps } from './PagesSearchTab';

const viewAtoms = new Map<string, PrimitiveAtom<PagesTypesViewMode>>();

function typesViewAtom(workspacePath: string, lane: string): PrimitiveAtom<PagesTypesViewMode> {
  const key = `${workspacePath}\u0000${lane}`;
  let viewAtom = viewAtoms.get(key);
  if (!viewAtom) {
    viewAtom = atom<PagesTypesViewMode>('map');
    viewAtoms.set(key, viewAtom);
  }
  return viewAtom;
}

export const PagesTypesTab: React.FC<PagesSectionTabProps> = ({ lane, workspacePath }) => {
  const section = usePagesSectionData(lane, workspacePath);
  if (!section) return <PagesSectionUnavailable section={section} />;
  return <PagesTypesTabBody lane={lane} workspacePath={workspacePath} section={section} />;
};

function PagesTypesTabBody({ lane, workspacePath, section }: PagesSectionTabProps & { section: PagesSectionData }) {
  const resolver = useCollabTypeResolver(lane);
  const defineType = useDefineTrackerType(workspacePath);
  const [view, setView] = useAtom(typesViewAtom(workspacePath, lane));
  const { scope, session, host } = section;
  const typePlacements = useAtomValue(session.atoms.typePlacements);
  return (
    <TrackersUIProvider {...section.provider}>
      <PagesTypesView
        lane={lane}
        typePlacements={typePlacements}
        view={view}
        onViewChange={setView}
        onOpenType={(typeId, options) => host.openArtifact({ kind: 'type', scope, typeId }, 'sidebar', options)}
        renderNewType={({ onClose, onCreated }) => (
          <NewTypeDialog lane={lane} resolver={resolver} session={session} defineType={defineType} onCreated={onCreated} onClose={onClose} />
        )}
      />
    </TrackersUIProvider>
  );
}
