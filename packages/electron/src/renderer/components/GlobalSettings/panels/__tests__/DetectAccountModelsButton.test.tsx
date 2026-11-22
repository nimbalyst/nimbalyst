// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { DetectAccountModelsButton } from '../DetectAccountModelsButton';
import type { DetectAccountModelsResult } from '../../../../../main/services/ai/claudeAccountModels';

function installInvoke(result: DetectAccountModelsResult | Promise<DetectAccountModelsResult>) {
  const invoke = vi.fn(async () => result);
  (window as any).electronAPI = { invoke };
  return invoke;
}

const click = () => fireEvent.click(screen.getByTestId('claude-detect-account-models'));

describe('DetectAccountModelsButton', () => {
  afterEach(() => {
    cleanup();
    delete (window as any).electronAPI;
    vi.clearAllMocks();
  });

  it('calls the detect channel once and reports the added models', async () => {
    const invoke = installInvoke({
      ok: true,
      added: [
        { model: 'claude-mythos-5-2', label: 'Claude Mythos 5.2' },
        { model: 'claude-mythos-5-1', label: 'Claude Mythos 5.1' },
      ],
      totalFromAccount: 5,
    });
    const onDetected = vi.fn(async () => {});
    render(<DetectAccountModelsButton onDetected={onDetected} />);

    expect(screen.getByTestId('claude-detect-account-models').textContent).toBe('Detect account models');
    click();

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Added 2 models: Claude Mythos 5.2, Claude Mythos 5.1')
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('claude-code:detect-account-models');
    expect(onDetected).toHaveBeenCalledTimes(1);
  });

  it('says so when the account has no new models', async () => {
    installInvoke({ ok: true, added: [], totalFromAccount: 3 });
    render(<DetectAccountModelsButton />);
    click();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('No new models found'));
  });

  it('shows the error text and does not refresh the list when sign-in is missing', async () => {
    installInvoke({ ok: false, error: 'not-signed-in', message: 'Sign in to Claude Code first.' });
    const onDetected = vi.fn(async () => {});
    render(<DetectAccountModelsButton onDetected={onDetected} />);
    click();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Sign in to Claude Code first.'));
    expect(onDetected).not.toHaveBeenCalled();
  });

  it('disables the button while the call is pending', async () => {
    let finish!: (result: DetectAccountModelsResult) => void;
    installInvoke(new Promise<DetectAccountModelsResult>((resolve) => { finish = resolve; }));
    render(<DetectAccountModelsButton />);
    click();

    const button = screen.getByTestId('claude-detect-account-models') as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(button.textContent).toBe('Detecting…');

    finish({ ok: true, added: [], totalFromAccount: 0 });
    await waitFor(() => expect(button.disabled).toBe(false));
  });
});
