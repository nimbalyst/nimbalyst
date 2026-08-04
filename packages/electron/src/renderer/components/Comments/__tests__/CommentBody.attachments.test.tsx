// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommentBody } from '../CommentBody';
import type { BodySegment, MessageAttachmentView } from '../commentTypes';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

function imageAttachment(
  overrides: Partial<MessageAttachmentView> = {},
): MessageAttachmentView {
  return {
    assetId: 'asset-1',
    fileName: 'screenshot.png',
    mimeType: 'image/png',
    byteSize: 2048,
    sizeLabel: '2 KB',
    isImage: true,
    src: 'collab-asset://doc/conversation-1/asset/asset-1',
    width: 800,
    height: 600,
    ...overrides,
  };
}

function renderSegments(segments: BodySegment[]) {
  return render(<CommentBody segments={segments} />);
}

describe('CommentBody attachments', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows an image inline, bounded, and addressed by its collab-asset URL', () => {
    renderSegments([{ type: 'attachments', attachments: [imageAttachment()] }]);

    const image = screen.getByAltText('screenshot.png') as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('collab-asset://doc/conversation-1/asset/asset-1');
    // Intrinsic dimensions travel so the row does not reflow when it loads.
    expect(image.getAttribute('width')).toBe('800');
    expect(image.className).toContain('max-h-[320px]');
  });

  it('opens the full-size image on click', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    renderSegments([{ type: 'attachments', attachments: [imageAttachment()] }]);

    fireEvent.click(screen.getByTestId('comment-body-attachment-image'));

    expect(open).toHaveBeenCalledWith('collab-asset://doc/conversation-1/asset/asset-1');
    vi.unstubAllGlobals();
  });

  it('renders a non-image as a downloadable chip with its name and size', () => {
    renderSegments([
      {
        type: 'attachments',
        attachments: [
          imageAttachment({
            assetId: 'asset-2',
            fileName: 'report.pdf',
            mimeType: 'application/pdf',
            sizeLabel: '1.4 MB',
            isImage: false,
          }),
        ],
      },
    ]);

    const chip = screen.getByTestId('comment-body-attachment-file') as HTMLAnchorElement;
    expect(chip.getAttribute('download')).toBe('report.pdf');
    expect(chip.textContent).toContain('report.pdf');
    expect(chip.textContent).toContain('1.4 MB');
    expect(screen.queryByTestId('comment-body-attachment-image')).toBeNull();
  });

  it('places the attachments after the message text', () => {
    const { container } = renderSegments([
      { type: 'text', text: 'have a look' },
      { type: 'attachments', attachments: [imageAttachment()] },
    ]);

    const body = container.querySelector('.comment-body')!;
    const attachments = body.querySelector('.comment-body-attachments')!;
    expect(body.textContent?.startsWith('have a look')).toBe(true);
    expect(
      body.compareDocumentPosition(attachments) & Node.DOCUMENT_POSITION_CONTAINED_BY,
    ).toBeTruthy();
    expect(attachments.previousSibling).not.toBeNull();
  });

  it('renders nothing extra for a message with no attachments', () => {
    renderSegments([{ type: 'text', text: 'just words' }]);

    expect(screen.queryByTestId('comment-body-attachments')).toBeNull();
  });
});
