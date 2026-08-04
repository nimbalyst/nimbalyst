// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { COMMENT_BODY_CONTRACT_CORPUS } from '../../../../../../collab-protocol/src/__tests__/commentBodyContractCorpus';
import { parseCommentBody, segmentsToPlainText } from '../commentBodyParser';
import { createCommentFixtures } from '../commentFixtures';
import { resourceRefToUrn } from '../resourceUrn';
import type { ResourcePillView, RichCommentBody } from '../commentTypes';

describe('comment body protocol contract', () => {
  it.each(COMMENT_BODY_CONTRACT_CORPUS)('$name', (fixture) => {
    const comments = createCommentFixtures();
    const pills = Object.fromEntries(
      fixture.resourceRefs.map((ref) => {
        const urn = resourceRefToUrn(ref);
        const pill: ResourcePillView = {
          urn,
          kind: ref.kind,
          availability: 'available',
          icon: 'link',
          label: ref.sourceId,
          actionable: true,
        };
        return [urn, pill];
      }),
    );

    const segments = parseCommentBody(fixture.body, {
      resourceRefs: fixture.resourceRefs,
      mentionedUserIds: fixture.deliveryHints.mentionedUserIds,
      mentionedAgentSessionIds: fixture.deliveryHints.mentionedAgentSessionIds,
      directory: comments.directory,
      viewerUserId: comments.viewerUserId,
      pills,
    });

    expect(segmentsToPlainText(segments)).toBe(fixture.expectedPlainText);
  });
});

describe('comment body attachments', () => {
  const ATTACHMENT = {
    assetId: 'asset-1',
    fileName: 'screenshot.png',
    mimeType: 'image/png',
    byteSize: 2048,
    width: 800,
    height: 600,
  } as const;

  function parse(body: RichCommentBody, assetDocumentId?: string) {
    const comments = createCommentFixtures();
    return parseCommentBody(body, {
      resourceRefs: [],
      mentionedUserIds: [],
      mentionedAgentSessionIds: [],
      directory: comments.directory,
      viewerUserId: comments.viewerUserId,
      pills: {},
      assetDocumentId,
    });
  }

  it('resolves an attachment to the conversation asset URL', () => {
    const segments = parse(
      { version: 1, format: 'nimbalystMarkdown', text: 'look', attachments: [ATTACHMENT] },
      'conversation-1',
    );

    expect(segments).toEqual([
      { type: 'text', text: 'look' },
      {
        type: 'attachments',
        attachments: [
          {
            assetId: 'asset-1',
            fileName: 'screenshot.png',
            mimeType: 'image/png',
            byteSize: 2048,
            sizeLabel: '2 KB',
            isImage: true,
            src: 'collab-asset://doc/conversation-1/asset/asset-1',
            width: 800,
            height: 600,
          },
        ],
      },
    ]);
  });

  it('renders attachments after the text, never inside it', () => {
    const segments = parse(
      {
        version: 1,
        format: 'nimbalystMarkdown',
        text: 'before **bold** after',
        attachments: [ATTACHMENT],
      },
      'conversation-1',
    );

    expect(segments[segments.length - 1].type).toBe('attachments');
    expect(segments.filter((segment) => segment.type === 'attachments')).toHaveLength(1);
  });

  it('keeps an attachment-only message visible to a plain-text preview', () => {
    const segments = parse(
      {
        version: 1,
        format: 'nimbalystMarkdown',
        text: '',
        attachments: [ATTACHMENT, { ...ATTACHMENT, assetId: 'asset-2', mimeType: 'application/pdf', fileName: 'report.pdf' }],
      },
      'conversation-1',
    );

    // Without this the inbox and reply snippets would show an empty message.
    expect(segmentsToPlainText(segments)).toBe('[image] [file]');
  });

  it('treats an SVG as a file, not an inline image', () => {
    const segments = parse(
      {
        version: 1,
        format: 'nimbalystMarkdown',
        text: '',
        attachments: [{ ...ATTACHMENT, mimeType: 'image/svg+xml', fileName: 'logo.svg' }],
      },
      'conversation-1',
    );

    expect(segments).toEqual([
      {
        type: 'attachments',
        attachments: [expect.objectContaining({ isImage: false })],
      },
    ]);
  });

  it('drops attachments rather than guessing an asset namespace', () => {
    expect(
      parse({ version: 1, format: 'nimbalystMarkdown', text: 'hi', attachments: [ATTACHMENT] }),
    ).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('leaves a body without attachments exactly as it was', () => {
    expect(
      parse({ version: 1, format: 'nimbalystMarkdown', text: 'plain' }, 'conversation-1'),
    ).toEqual([{ type: 'text', text: 'plain' }]);
  });
});
