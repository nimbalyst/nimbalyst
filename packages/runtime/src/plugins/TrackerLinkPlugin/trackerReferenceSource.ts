/**
 * The typed page a tracker reference sits in.
 *
 * A link's relation options depend on the pair (this page's type, the linked
 * item's type). The chip knows the linked item; the host editor that renders a
 * tracker item's body knows the page, and says so by wrapping its editor in
 * {@link TrackerReferenceSourceProvider}. Lexical decorators render inside the
 * composer's React tree, so every chip in that body reads it. Anywhere without
 * a provider (plain documents, transcripts) the chip offers no relations.
 */

import { createContext, useContext } from 'react';

export interface TrackerReferenceSource {
  /** Tracker item id of the page being edited. */
  itemId: string;
  /** Its tracker type (`primaryType`). */
  type: string;
}

const TrackerReferenceSourceContext = createContext<TrackerReferenceSource | null>(null);

export const TrackerReferenceSourceProvider = TrackerReferenceSourceContext.Provider;

export function useTrackerReferenceSource(): TrackerReferenceSource | null {
  return useContext(TrackerReferenceSourceContext);
}
