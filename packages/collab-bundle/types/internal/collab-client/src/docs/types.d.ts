export interface SharedDocument {
    documentId: string;
    /** Owning project preserved from the team document index. */
    teamProjectId: string | null;
    title: string;
    documentType: string;
    /** Optional V2 type metadata; legacy rows are inferred at read time. */
    metadataVersion?: 2;
    /** Exact normalized suffix, including the leading dot. */
    fileExtension?: string;
    /** Stable owning editor id (built-in or extension id). */
    editorId?: string;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
    /** User id of whoever most recently changed this doc. */
    lastWriterUserId?: string | null;
    /** First-class parent folder; null/undefined means root. */
    parentFolderId?: string | null;
    /** Millisecond epoch when moved to recoverable Trash. */
    trashedAt?: number | null;
    /** True when the encrypted title could not be decrypted. */
    decryptFailed?: boolean;
}
export interface SharedFolder {
    folderId: string;
    /** Null/undefined means root level. */
    parentFolderId?: string | null;
    name: string;
    sortOrder: number;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
    /** True when the encrypted folder name could not be decrypted. */
    decryptFailed?: boolean;
}
