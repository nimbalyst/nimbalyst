import type {
  CollabCommand,
  CollabCommandResult,
  CollabDataSource,
} from '@nimbalyst/collab-client/core';
import type { SharedDocument, SharedFolder } from './types';

export type CollabDocsCommand =
  | {
      type: 'register-document';
      documentId: string;
      title: string;
      documentType: string;
      parentFolderId: string | null;
      metadata?: { metadataVersion: 2; fileExtension: string; editorId: string };
    }
  | { type: 'update-document-title'; documentId: string; title: string }
  | { type: 'remove-document'; documentId: string }
  | { type: 'trash-document'; documentId: string; trashedAt: number }
  | { type: 'restore-document'; documentId: string }
  | { type: 'move-document'; documentId: string; parentFolderId: string | null }
  | {
      type: 'register-folder';
      folderId: string;
      name: string;
      parentFolderId: string | null;
      sortOrder: number;
    }
  | { type: 'rename-folder'; folderId: string; name: string }
  | { type: 'move-folder'; folderId: string; parentFolderId: string | null }
  | { type: 'remove-folder'; folderId: string }
  | { type: 'refresh-folders' }
  | { type: 'reconnect' };

export interface CollabDocsCommandResult extends CollabCommandResult {
  folders?: SharedFolder[] | null;
}

export type CollabDocsDataSource = CollabDataSource<
  SharedDocument,
  SharedFolder,
  CollabDocsCommand,
  CollabDocsCommandResult
>;

// Compile-time assertion that the document command union stays compatible
// with the artifact-agnostic command seam.
const _collabDocsCommand: CollabCommand = {} as CollabDocsCommand;
void _collabDocsCommand;
