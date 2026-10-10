/**
 * A view placed in a page: a link alone on its line whose URL names what to
 * show and whose title holds how to show it.
 *
 *   [Competitors](https://console.nimbalyst.com/org/<o>/project/<p>/view/type/competitor "cols=title,realtime sort=realtime:desc")
 *   [Decided](https://console.nimbalyst.com/app/view/marks?kind=decided)
 *
 * The URL is a console link (Decision 23) for the page's own scope: a team
 * page names its team project, a Personal page is `local`. Pages written
 * before that carry `nimbalyst://view/...`, which still reads.
 *
 * The definition lives in the page, not in a saved-view record, so a page
 * carries its views when it is copied or shared. The link upgrades into an
 * `EmbeddedFileNode` (a view is not a file, so it needs no registered type),
 * and each host's embed renderer branches on `parsePlacedViewUrl`.
 *
 * Title values never contain whitespace or quotes: the embed title is written
 * inside `"..."`, so anything free-form (axis labels, pinned point names) is
 * percent-encoded with `encodeViewAttrValue`.
 *
 * This module is the only place that knows the URL shape: everything else
 * builds with `createPlacedViewUrl` and reads with `parsePlacedViewUrl`, so
 * the scheme can change here alone.
 *
 * Pure (console links come from collab-protocol): it is on the editor's eager path.
 */
import { type ConsoleLinkScope } from '@nimbalyst/collab-protocol';
export type PlacedViewMarksKind = 'decided' | 'open' | 'all';
export type PlacedViewScope = ConsoleLinkScope;
/** `scope` is set when the link is a console link: the team project it names, or `local`. */
export type PlacedViewTarget = {
    kind: 'type';
    typeId: string;
    scope?: PlacedViewScope;
} | {
    kind: 'marks';
    marks: PlacedViewMarksKind;
    scope?: PlacedViewScope;
};
/** What a placed-view link shows, or null for any other href. The one parser. */
export declare function parsePlacedViewUrl(url: string | null | undefined): PlacedViewTarget | null;
/**
 * The one builder; the markdown helpers go through it. With a scope (the
 * page's own) it writes a console link; without one, the older app link.
 */
export declare function createPlacedViewUrl(target: PlacedViewTarget, scope?: PlacedViewScope | undefined): string;
/** Percent-encodes a free-form title value so it holds no space, quote or `=`. */
export declare function encodeViewAttrValue(value: string): string;
/** Reverses `encodeViewAttrValue`; a hand-written `+` reads as a space. */
export declare function decodeViewAttrValue(value: string): string;
/**
 * The markdown a page stores for a placed view. `attrs` values must already be
 * title-safe (see `encodeViewAttrValue`); empty values are dropped.
 */
export declare function createPlacedViewMarkdown(target: PlacedViewTarget, label: string, attrs?: Record<string, string>, scope?: PlacedViewScope): string;
