import { createContext } from 'react';

/**
 * Whether a tracker tab leads with its issue key. Pages turns it off: there an
 * item is a page, named by its title like every other page.
 */
export const TrackerTabIssueKeyContext = createContext(true);
