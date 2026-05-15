/**
 * Type and protocol tests for CollabV3
 */

import { describe, it, expect } from 'vitest';
import type {
  ClientMessage,
  ServerMessage,
  EncryptedMessage,
  SessionIndexEntry,
  SessionRoomId,
  IndexRoomId,
} from '../src/types';

describe('Room ID formats', () => {
  it('should match SessionRoomId pattern', () => {
    const validIds: SessionRoomId[] = [
      'org:org1:user:abc123:session:sess456',
      'org:org-2:user:user-with-dashes:session:session-id',
    ];

    for (const id of validIds) {
      expect(id).toMatch(/^org:[^:]+:user:[^:]+:session:[^:]+$/);
    }
  });

  it('should match IndexRoomId pattern', () => {
    const validIds: IndexRoomId[] = [
      'org:org1:user:abc123:index',
      'org:org-2:user:user-with-dashes:index',
    ];

    for (const id of validIds) {
      expect(id).toMatch(/^org:[^:]+:user:[^:]+:index$/);
    }
  });
});

describe('Message protocol', () => {
  it('should create valid syncRequest message', () => {
    const msg: ClientMessage = {
      type: 'syncRequest',
      sinceSeq: 42,
    };

    expect(msg.type).toBe('syncRequest');
    expect(JSON.stringify(msg)).toBeTruthy();
  });

  it('should create valid appendMessage message', () => {
    const encryptedMessage: EncryptedMessage = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      sequence: 1,
      createdAt: Date.now(),
      source: 'user',
      direction: 'input',
      encryptedContent: 'base64encodedcontent==',
      iv: 'base64encodediv==',
      metadata: {},
    };

    const msg: ClientMessage = {
      type: 'appendMessage',
      message: encryptedMessage,
    };

    expect(msg.type).toBe('appendMessage');
    expect(msg.message.source).toBe('user');
  });

  it('should create valid syncResponse message', () => {
    const msg: ServerMessage = {
      type: 'syncResponse',
      messages: [],
      metadata: {
        encryptedTitle: 'base64-encrypted-title',
        titleIv: 'base64-title-iv',
        provider: 'claude',
        encryptedProjectId: 'base64-encrypted-project-id',
        projectIdIv: 'base64-iv',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      hasMore: false,
      cursor: null,
    };

    expect(msg.type).toBe('syncResponse');
    if (msg.type === 'syncResponse') {
      expect(msg.metadata?.encryptedTitle).toBe('base64-encrypted-title');
      expect(msg.metadata?.titleIv).toBe('base64-title-iv');
    }
  });

  it('should create valid indexSyncResponse message', () => {
    const session: SessionIndexEntry = {
      sessionId: 'sess-123',
      encryptedProjectId: 'base64-encrypted-project-id',
      projectIdIv: 'base64-iv',
      encryptedTitle: 'base64-encrypted-title',
      titleIv: 'base64-iv',
      provider: 'claude',
      messageCount: 10,
      lastMessageAt: Date.now(),
      createdAt: Date.now() - 86400000,
      updatedAt: Date.now(),
    };

    const msg: ServerMessage = {
      type: 'indexSyncResponse',
      sessions: [session],
      projects: [
        {
          encryptedProjectId: 'base64-encrypted-project-id',
          projectIdIv: 'base64-iv',
          encryptedName: 'base64-encrypted-name',
          nameIv: 'base64-iv',
          sessionCount: 1,
          lastActivityAt: Date.now(),
          syncEnabled: true,
        },
      ],
    };

    expect(msg.type).toBe('indexSyncResponse');
    if (msg.type === 'indexSyncResponse') {
      expect(msg.sessions).toHaveLength(1);
      expect(msg.projects).toHaveLength(1);
    }
  });
});

describe('Encrypted message format', () => {
  it('should have required fields', () => {
    const msg: EncryptedMessage = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      sequence: 1,
      createdAt: 1234567890123,
      source: 'assistant',
      direction: 'output',
      encryptedContent: 'SGVsbG8gV29ybGQ=',
      iv: 'MTIzNDU2Nzg5MDEyMzQ1Ng==',
      metadata: {},
    };

    expect(msg.id).toBeTruthy();
    expect(msg.sequence).toBeGreaterThan(0);
    expect(msg.encryptedContent).toBeTruthy();
    expect(msg.iv).toBeTruthy();
    expect(['user', 'assistant', 'tool', 'system']).toContain(msg.source);
    expect(['input', 'output']).toContain(msg.direction);
  });

  it('should have empty metadata (all sensitive data is encrypted)', () => {
    const msg: EncryptedMessage = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      sequence: 1,
      createdAt: Date.now(),
      source: 'tool',
      direction: 'output',
      encryptedContent: 'encrypted',
      iv: 'iv',
      metadata: {},
    };

    expect(msg.metadata).toEqual({});
  });
});
