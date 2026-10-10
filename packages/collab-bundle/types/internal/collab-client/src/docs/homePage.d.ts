/**
 * Home: one page pinned first in each Pages section. The TeamRoom seeds a
 * team's Home once per team project (`home:{teamProjectId}`), and the desktop
 * seeds the Personal Home once per workspace (`home:personal`). Each is an
 * ordinary page that can be edited, renamed, moved or deleted, and is never
 * seeded again. Only the id prefix marks it, so the tree can pin it with no
 * extra wire field.
 */
export declare const HOME_PAGE_ID_PREFIX = "home:";
export declare function isHomePageId(documentId: string): boolean;
