import { describe, expect, it } from 'vitest';

import {
  classifyDocumentClose,
  parseDocumentServerSignal,
} from '../serverSignals';

describe('document room server signals', () => {
  it('preserves the originating clientUpdateId on a read-only rejection', () => {
    expect(parseDocumentServerSignal(JSON.stringify({
      type: 'error',
      code: 'document_read_only',
      message: 'Role permits reading only',
      clientUpdateId: 'client-update-17',
    }))).toEqual({
      type: 'read-only',
      message: 'Role permits reading only',
      clientUpdateId: 'client-update-17',
    });
  });

  it('distinguishes proactive read-only from write-correlated rejection', () => {
    expect(parseDocumentServerSignal(JSON.stringify({
      type: 'error',
      code: 'document_read_only',
      message: 'Project access changed',
    }))).toEqual({
      type: 'read-only',
      message: 'Project access changed',
    });
  });

  it('distinguishes terminal authorization closes from ordinary disconnects', () => {
    expect(classifyDocumentClose(4002, 'Removed from team')).toEqual({
      reason: 'removed-from-org',
      closeCode: 4002,
      message: 'Removed from team',
    });
    expect(classifyDocumentClose(4003, 'Document access revoked')).toEqual({
      reason: 'document-access-revoked',
      closeCode: 4003,
      message: 'Document access revoked',
    });
    expect(classifyDocumentClose(1006, '')).toBeNull();
  });
});
