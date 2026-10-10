import type { MultilineElementTransformer } from '@lexical/markdown';
import { EmbeddedFileNode } from './EmbeddedFileNodeCore';
export declare const NAMED_PAGE_VIEW_ID = "namedPageView";
export interface NamedPageView {
    id: string;
    name: string;
    type: string;
    attrs: Record<string, string>;
}
export declare function parseNamedPageView(source: string): NamedPageView;
export declare function namedPageViewFromNode(node: EmbeddedFileNode): NamedPageView | null;
/** One fence per view; existing embedded nodes keep names and individual settings independently mergeable. */
export declare const NAMED_PAGE_VIEW_TRANSFORMER: MultilineElementTransformer;
