import { type LexicalEditor } from 'lexical';
import { type NamedPageView } from './namedPageView';
export interface NamedPageViewsSnapshot {
    views: NamedPageView[];
    editable: boolean;
    error: string | null;
}
export interface NamedPageViewsController {
    getSnapshot(): NamedPageViewsSnapshot;
    subscribe(listener: () => void): () => void;
    add(id: string, name: string, attrs: Record<string, string>): void;
    rename(id: string, name: string): void;
    patch(id: string, attrs: Readonly<Record<string, string | null>>): void;
    remove(id: string): void;
    dispose(): void;
}
/** All writes target the live editor, never a copied Markdown body or another view store. */
export declare function createNamedPageViewsController(editor: LexicalEditor, typeId: string): NamedPageViewsController;
