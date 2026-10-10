/**
 * Auto-sizing for the tracker title field (the detail pane and the typed page).
 *
 * The title editor is a textarea rather than an `<input>` so long titles wrap
 * instead of scrolling horizontally. A textarea has a fixed row height, so its
 * height has to be recomputed from the content whenever the text or the
 * available width changes.
 */
/** Beyond this the title scrolls internally instead of pushing the header down. */
export declare const TITLE_MAX_HEIGHT_PX = 160;
/** Titles are single-line values; pasted newlines become spaces. */
export declare function sanitizeTitleInput(value: string): string;
/**
 * Fit a textarea to its content, capped at `maxHeightPx`. Height is reset to
 * `auto` first so the element can shrink as well as grow.
 */
export declare function resizeTitleField(el: HTMLTextAreaElement | null, maxHeightPx?: number): void;
/**
 * Keeps the title textarea sized to its content. Re-fits when `value` changes
 * and when the element's width changes (pane resize), but not when its own
 * height changes -- that would feed back into the observer.
 */
export declare function useAutoSizedTitle(value: string): (el: HTMLTextAreaElement | null) => void;
