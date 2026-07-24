import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmptyWorkstreamState } from '../EmptyWorkstreamState';

afterEach(cleanup);

describe('EmptyWorkstreamState', () => {
  it('shows a truthful empty state with a working creation affordance', () => {
    const onNewSession = vi.fn();
    render(<EmptyWorkstreamState onNewSession={onNewSession} />);

    expect(screen.getByText('This workstream has no sessions.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(onNewSession).toHaveBeenCalledOnce();
    expect(screen.queryByText('Loading sessions...')).toBeNull();
  });
});
