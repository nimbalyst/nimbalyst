/**
 * The prose page of a tracker type, `type-page:<typeId>`: the register step
 * every host runs the first time someone writes about a type.
 *
 * It starts empty, so registering the row is the whole creation. A row that
 * already exists (another client got there first) is returned. A same-named
 * page beside it, or a parent that is gone, does not stop it: the tree never
 * shows this row, so its name and place only matter to clients that predate
 * type pages. The host supplies the actual create, which differs per host.
 */
import { type SharedDocument } from './types';
export interface TypePageDocumentRequest {
    typeId: string;
    /** The type's plural name: the document's name in the index. */
    typeName: string;
    /** The page the type sits under (its placement parent); null at the root. */
    parentFolderId: string | null;
}
export interface TypePageCreateAttempt {
    documentId: string;
    requestedName: string;
    parentFolderId: string | null;
    /** Distinguishes a retry, so a host keying operations by id does not replay the refused one. */
    operationSuffix: '' | ':renamed' | ':root';
}
export interface TypePageDocumentEffects {
    existing(documentId: string): SharedDocument | undefined;
    create(attempt: TypePageCreateAttempt): Promise<SharedDocument>;
    /** Why a create was refused, when it is a refusal a retry gets past; null rethrows. */
    refusal(error: unknown): 'name-collision' | 'invalid-parent' | null;
}
export declare function typePageDocumentId(typeId: string): string;
export declare function ensureTypePageDocument(request: TypePageDocumentRequest, effects: TypePageDocumentEffects): Promise<SharedDocument>;
