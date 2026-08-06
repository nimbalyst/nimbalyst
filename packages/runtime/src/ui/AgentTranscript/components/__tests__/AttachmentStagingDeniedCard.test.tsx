import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '../../../../store/store';
import { setInteractiveWidgetHost } from '../../../../store/atoms/interactiveWidgetHost';
import type { InteractiveWidgetHost } from '../CustomToolWidgets/InteractiveWidgetHost';
import { AttachmentStagingDeniedCard } from '../AttachmentStagingDeniedCard';

const sessionId = 'attachment-staging-session';

function renderCard(host: InteractiveWidgetHost) {
  setInteractiveWidgetHost(sessionId, host);
  return render(
    <JotaiProvider store={store}>
      <AttachmentStagingDeniedCard
        sessionId={sessionId}
        systemMessage={{
          systemType: 'permission_denied',
          isAttachmentStagingDenied: true,
          attachmentFilename: 'report.txt',
          attachmentDenyRule: 'Read(**/AppData/**)',
        }}
        prompt="Summarize this report"
        attachments={[{
          id: 'attachment-1',
          filename: 'report.txt',
          filepath: '/tmp/report.txt',
          mimeType: 'text/plain',
          size: 42,
          type: 'document',
        }]}
      />
    </JotaiProvider>,
  );
}

afterEach(() => setInteractiveWidgetHost(sessionId, null));

describe('AttachmentStagingDeniedCard', () => {
  it('offers the opt-in gitignore checkbox and retries with the original prompt and attachment', async () => {
    const retryAttachmentStaging = vi.fn().mockResolvedValue({ success: true });
    const host = {
      getAttachmentStagingGitignoreStatus: vi.fn().mockResolvedValue({
        isGitRepo: true,
        alreadyIgnored: false,
        shouldOffer: true,
      }),
      retryAttachmentStaging,
      openAttachmentSettings: vi.fn(),
    } as unknown as InteractiveWidgetHost;
    renderCard(host);

    const checkbox = await screen.findByRole('checkbox');
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Move attachments into the workspace and retry' }));

    await waitFor(() => expect(retryAttachmentStaging).toHaveBeenCalledWith(
      'Summarize this report',
      [expect.objectContaining({ filename: 'report.txt', filepath: '/tmp/report.txt' })],
      true,
    ));
  });

  it('opens attachment settings as a secondary action', () => {
    const openAttachmentSettings = vi.fn();
    renderCard({ openAttachmentSettings } as unknown as InteractiveWidgetHost);
    fireEvent.click(screen.getByRole('button', { name: 'Attachment settings' }));
    expect(openAttachmentSettings).toHaveBeenCalledOnce();
  });
});
