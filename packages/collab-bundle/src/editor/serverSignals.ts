import type { CollabEditorTermination } from './types';

export type ObservedDocumentServerSignal =
  | {
      type: 'write-acknowledged';
      clientUpdateId: string;
    }
  | {
      /**
       * The room's current write verdict, carried by every sync response and
       * by `document_writable` when an open connection gains body write.
       */
      type: 'access-verdict';
      canWrite: boolean;
      /** Present from servers that model commenters; see `docSyncResponse.canComment`. */
      canComment?: boolean;
    }
  | {
      type: 'read-only';
      message: string;
      clientUpdateId?: string;
    }
  | {
      /**
       * A connected editor was demoted to commenter (`document_comment_only`,
       * sent on a role change). Not a rejection and not terminal: the body
       * locks and commenting stays, the same access a sync verdict of
       * `canWrite: false, canComment: true` gives.
       */
      type: 'comment-only';
      message: string;
    }
  | {
      /**
       * A commenter's docUpdate changed more than the comment threads
       * (`document_comment_update_refused`). Terminal; the room closes 4009.
       * `document_comment_forbidden` (a refused docCompact) is deliberately
       * not a signal: the socket stays open and a commenter never compacts.
       */
      type: 'comment-update-refused';
      message: string;
      clientUpdateId?: string;
    }
  | {
      type: 'access-revoked';
      message: string;
      clientUpdateId?: string;
    };

/**
 * Server access from a sync response's verdict. `canWrite: false` alone stays
 * read-only, as from a server that predates commenters; with
 * `canComment: true` it is a commenter.
 */
export function serverAccessFromVerdict(
  verdict: { canWrite: boolean; canComment?: boolean },
): 'writable' | 'comment-only' | 'read-only' {
  if (verdict.canWrite) return 'writable';
  return verdict.canComment === true ? 'comment-only' : 'read-only';
}

/** Inspect only authorization/durability signals; DocumentSync owns all decoding. */
export function parseDocumentServerSignal(data: unknown): ObservedDocumentServerSignal | null {
  if (typeof data !== 'string') return null;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (!message || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  if (record.type === 'docUpdateAck' && typeof record.clientUpdateId === 'string') {
    return { type: 'write-acknowledged', clientUpdateId: record.clientUpdateId };
  }
  // An older server omits the field. Falling through to null leaves access
  // unknown, which is what lets the host's own answer still decide.
  if (record.type === 'docSyncResponse' && typeof record.canWrite === 'boolean') {
    return {
      type: 'access-verdict',
      canWrite: record.canWrite,
      ...(typeof record.canComment === 'boolean' ? { canComment: record.canComment } : {}),
    };
  }
  if (record.type !== 'error' || typeof record.code !== 'string') return null;
  const details = {
    message: typeof record.message === 'string' ? record.message : record.code,
    ...(typeof record.clientUpdateId === 'string'
      ? { clientUpdateId: record.clientUpdateId }
      : {}),
  };
  if (record.code === 'document_read_only') return { type: 'read-only', ...details };
  // Body write granted to an open connection (a role change; resent
  // harmlessly after hibernation). The same answer a sync verdict of
  // `canWrite: true` gives, so it lands through the same path.
  if (record.code === 'document_writable') {
    return { type: 'access-verdict', canWrite: true };
  }
  if (record.code === 'document_comment_only') {
    return { type: 'comment-only', message: details.message };
  }
  if (record.code === 'document_comment_update_refused') {
    return { type: 'comment-update-refused', ...details };
  }
  if (record.code === 'document_access_revoked') return { type: 'access-revoked', ...details };
  return null;
}

export function classifyDocumentClose(
  code: number,
  reason: string,
): CollabEditorTermination | null {
  if (code === 4002) {
    return { reason: 'removed-from-org', closeCode: 4002, message: reason || 'Removed from team' };
  }
  if (code === 4003) {
    return {
      reason: 'document-access-revoked',
      closeCode: 4003,
      message: reason || 'Document access revoked',
    };
  }
  // A deleted document is terminal in the same way access removal is: the room
  // is gone, so reconnecting can only fail again. Hosts need it distinguished
  // from a revocation because it is not an access problem to explain away.
  if (code === 4004) {
    return { reason: 'deleted-document', closeCode: 4004, message: reason || 'Document was deleted' };
  }
  // A commenter's refused update leaves this Y.Doc unable to sync again; the
  // host remounts with a fresh one rather than reconnecting this one.
  if (code === 4009) {
    return {
      reason: 'comment-update-refused',
      closeCode: 4009,
      message: reason || 'Comment update refused',
    };
  }
  return null;
}
