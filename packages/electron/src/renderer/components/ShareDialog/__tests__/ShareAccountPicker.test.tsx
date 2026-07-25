// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShareAccountPicker } from '../ShareAccountPicker';

describe('ShareAccountPicker', () => {
  afterEach(() => cleanup());

  it('preselects the workspace-bound account and allows an explicit choice', () => {
    const onChange = vi.fn();
    render(
      <ShareAccountPicker
        accounts={[
          { personalOrgId: 'personal', email: 'me@example.com', isSyncAccount: true, sessionStatus: 'active' },
          { personalOrgId: 'work', email: 'work@example.com', isSyncAccount: false, sessionStatus: 'active' },
        ]}
        selectedPersonalOrgId="work"
        defaultSource="workspace-binding"
        onChange={onChange}
      />,
    );

    expect((screen.getByRole('radio', { name: /work@example.com/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/bound to this workspace/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /me@example.com/ }));
    expect(onChange).toHaveBeenCalledWith('personal');
  });
});
