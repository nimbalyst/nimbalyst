/**
 * The decisions or open questions marked across pages
 * (a placed-view link of marks, see `placedViewUrl.ts`), read through the
 * host's page-marks source. Each row is the marked sentence, its faint
 * who / when / not-chosen line, and the page it is on.
 *
 * Optional title attrs: `type=<typeId>` (only pages of that type),
 * `search=<text>` (percent-encoded), `limit=<n>`.
 */
import { type JSX } from 'react';
import { type CollabOpenOptions } from '../../core/index';
import { type PlacedViewMarksKind } from '../../../../runtime/src/core/placedViewUrl';
import { type PageMarksQuery } from '../../pages';
export interface MarksListEmbedProps {
    kind: PlacedViewMarksKind;
    label: string;
    attrs: Readonly<Record<string, string>>;
    /** Opens the page a mark is on, by its tab uri (`tracker://...`, `personal://...`). */
    /** `options` carries Cmd/Ctrl from the click, so a host can open a new tab. */
    onOpenPage?: (uri: string, options?: CollabOpenOptions) => void;
}
export declare function marksQuery(kind: PlacedViewMarksKind, attrs: Readonly<Record<string, string>>): PageMarksQuery;
export declare function MarksListEmbed({ kind, label, attrs, onOpenPage }: MarksListEmbedProps): JSX.Element;
