import type { TrackerCreateItemInput } from '../trackers/dataSource';
export interface BrowserPageTypeItemRequest {
    typeId: string;
    title: string;
    markdown: string;
    /** The browser data source's workspace path for the project. */
    workspace: string;
}
/** Throws when the type cannot take the item (unknown, not creatable, invalid). */
export declare function browserPageTypeItemInput(request: BrowserPageTypeItemRequest): TrackerCreateItemInput;
