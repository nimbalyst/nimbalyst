import { describe, expect, it, vi } from 'vitest';
import { DocumentSyncProvider } from '../DocumentSync';
import {
  encodeDocumentRoomId,
  isValidCollabDocumentId,
} from '../collabDocumentId';

describe('isValidCollabDocumentId', () => {
  it('recognizes UUIDs and sha256 hex digests as plain URL-safe ids', () => {
    expect(isValidCollabDocumentId('8db44617-7c4a-4964-ad29-61291b781541')).toBe(true);
    expect(isValidCollabDocumentId('a'.repeat(64))).toBe(true);
    expect(isValidCollabDocumentId('doc-1')).toBe(true);
    expect(isValidCollabDocumentId('Doc_123-abc')).toBe(true);
  });

  it('flags filename- and path-shaped ids as not plain URL-safe', () => {
    expect(isValidCollabDocumentId('Integration 80% of Everything.md')).toBe(false);
    expect(isValidCollabDocumentId('notes/todo.md')).toBe(false);
    expect(isValidCollabDocumentId('has space')).toBe(false);
    expect(isValidCollabDocumentId('trailing.dot.md')).toBe(false);
    expect(isValidCollabDocumentId('')).toBe(false);
    expect(isValidCollabDocumentId(undefined)).toBe(false);
  });
});

describe('encodeDocumentRoomId', () => {
  it('is a no-op for UUID / hex ids', () => {
    const id = '8db44617-7c4a-4964-ad29-61291b781541';
    expect(encodeDocumentRoomId('org-1', id)).toBe(`org:org-1:doc:${id}`);
  });

  it('percent-encodes filename ids so the room id is URL-safe', () => {
    const roomId = encodeDocumentRoomId('org-1', 'Integration 80% of Everything.md');
    expect(roomId).toBe('org:org-1:doc:Integration%2080%25%20of%20Everything.md');
    // The whole thing must survive URL construction without throwing.
    expect(() => new URL(`wss://x.test/sync/${roomId}`)).not.toThrow();
    // And it round-trips back to the raw id after :doc:.
    const decoded = decodeURIComponent(roomId.slice(roomId.indexOf(':doc:') + ':doc:'.length));
    expect(decoded).toBe('Integration 80% of Everything.md');
  });
});

describe('DocumentSyncProvider.connect with a filename-shaped documentId', () => {
  it('connects with the documentId URL-encoded (no raw space / %)', async () => {
    let capturedUrl = '';
    const fakeSocket = { addEventListener: vi.fn(), close: vi.fn(), send: vi.fn() };
    const createWebSocket = vi.fn((url: string) => {
      capturedUrl = url;
      return fakeSocket;
    });

    const provider = new DocumentSyncProvider({
      serverUrl: 'ws://example.test',
      getJwt: async () => 'token',
      orgId: 'org-1',
      userId: 'user-1',
      documentId: 'Integration 80% of Everything.md',
      reviewGateEnabled: false,
      createWebSocket: createWebSocket as unknown as (url: string) => WebSocket,
    });

    await provider.connect();

    expect(createWebSocket).toHaveBeenCalledTimes(1);
    // The room path segment must be encoded -- no raw spaces, and the only '%'
    // are percent-escapes. The URL must be constructible.
    const pathPart = capturedUrl.split('?')[0];
    expect(pathPart).not.toMatch(/ /);
    expect(pathPart).toContain('doc:Integration%2080%25%20of%20Everything.md');
    expect(() => new URL(capturedUrl)).not.toThrow();

    provider.destroy();
  });
});
