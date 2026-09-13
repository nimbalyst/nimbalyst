import type {
  FileIndexEntry,
  ProjectIndexEntry,
  SessionIndexEntry,
  ReadReceiptSyncBroadcastMessage,
  TrackerPersonalStateSyncBroadcastMessage,
} from './personal.js';

/** Separate from UI activity timestamps. Revisions are owned by the personal IndexRoom. */
export type IndexEntity = 'session' | 'project' | 'file';
export interface IndexChange {
  entity: IndexEntity;
  id: string;
  revision: number;
  deleted: boolean;
  /** A remote cache expiry is not an instruction to delete desktop history. */
  removalReason?: 'expired' | 'deleted';
  session?: SessionIndexEntry;
  project?: ProjectIndexEntry;
  file?: FileIndexEntry;
}

/** Opt-in protocol: legacy indexSyncRequest/Response retain their complete-snapshot meaning. */
export interface IndexPageRequestMessage {
  type: 'indexPageRequest';
  protocolVersion: 2;
  requestId: string;
  mode: 'bootstrap' | 'delta' | 'recent' | 'lookup';
  pageToken?: string;
  sinceRevision?: number;
  projectId?: string;
  sessionIds?: string[];
  limit?: number;
}
export interface IndexPageResponseMessage {
  type: 'indexPageResponse';
  protocolVersion: 2;
  requestId: string;
  mode: IndexPageRequestMessage['mode'];
  entries: IndexChange[];
  nextPageToken?: string;
  /** Only a completed bootstrap+replay or a committed contiguous delta page establishes coverage. */
  cursor?: number;
  complete: boolean;
  resetRequired?: boolean;
}

/** A wake-up hint, never an applied cursor or evidence of complete cache coverage. */
export interface IndexChangesAvailableMessage {
  type: 'indexChangesAvailable';
  revision: number;
}

/** Independent reconnect replay; these pages never establish index coverage. */
export interface PersonalStatePageRequestMessage {
  type: 'personalStatePageRequest';
  requestId: string;
  pageToken?: string;
  limit?: number;
}
export interface PersonalStatePageResponseMessage {
  type: 'personalStatePageResponse';
  requestId: string;
  entries: Array<
    ReadReceiptSyncBroadcastMessage | TrackerPersonalStateSyncBroadcastMessage
  >;
  nextPageToken?: string;
  complete: boolean;
}
