// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GH_WORKFLOW_SCOPE_REFRESH_COMMAND,
  PullRequestActionError,
} from '../PullRequestActionError';

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(cleanup);

describe('PullRequestActionError', () => {
  it('shows and copies the workflow-scope recovery command', async () => {
    const error = `GitHub blocked this merge. Run: ${GH_WORKFLOW_SCOPE_REFRESH_COMMAND}`;
    const { getByRole, getByTestId } = render(<PullRequestActionError error={error} />);

    expect(getByRole('alert').textContent).toContain(GH_WORKFLOW_SCOPE_REFRESH_COMMAND);
    fireEvent.click(getByTestId('pr-copy-workflow-scope-command'));

    expect(writeText).toHaveBeenCalledWith(GH_WORKFLOW_SCOPE_REFRESH_COMMAND);
    await waitFor(() =>
      expect(getByTestId('pr-copy-workflow-scope-command').textContent).toBe('Copied'),
    );
  });

  it('does not offer the recovery action for unrelated failures', () => {
    const { queryByTestId } = render(<PullRequestActionError error="Merge conflict" />);
    expect(queryByTestId('pr-copy-workflow-scope-command')).toBeNull();
  });
});
