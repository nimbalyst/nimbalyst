/**
 * The default view of a type page: every item of one tracker type, as a table.
 * Built in code rather than saved, so a type has a page before anyone names a
 * view for it. Named views are created on purpose and are not derived here.
 */

import { createDefaultViewDefinition, type SavedView } from '@nimbalyst/collab-client/trackers';

export function createTypePageView(typeId: string): SavedView {
  return {
    id: `type-page:${typeId}`,
    name: 'All',
    builtIn: true,
    definition: {
      ...createDefaultViewDefinition(),
      selectedType: typeId,
      viewMode: 'table',
      statusScope: 'all',
      recentlyViewedDays: null,
    },
  };
}
