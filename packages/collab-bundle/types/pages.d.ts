/**
 * Knowledge pages for a browser host: the cross-page marks contract
 * (decisions and open questions) and the mapping from the team's marks index.
 *
 * Its own small entry so the docs route can install a marks source without
 * pulling the tracker grid, while `trackers-ui` (where a marks view renders)
 * shares this one module instance, and with it the installed source.
 */
export * from './internal/collab-client/src/pages/index';
export { onTeamPageMarksChanged, TeamPageMarksRequests } from './internal/runtime/src/sync/teamPageMarks';
export type { TeamPageMarksFilters, TeamPageMarksResult } from './internal/runtime/src/sync/teamPageMarks';
export { onTeamPageLinksChanged, TeamPageLinksRequests } from './internal/runtime/src/sync/teamPageLinks';
export type { TeamPageLinksFilters, TeamPageLinksResult } from './internal/runtime/src/sync/teamPageLinks';
