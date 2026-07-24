import type { DocumentRecord } from '../../core/types';

export interface DocumentsRepository {
  list(workspaceId: string): Promise<DocumentRecord[]>;
  get(id: string): Promise<DocumentRecord | null>;
  create(workspaceId: string, title?: string): Promise<DocumentRecord>;
  save(doc: Pick<DocumentRecord, 'id' | 'title' | 'content'>): Promise<void>;
  remove(id: string): Promise<void>;
}