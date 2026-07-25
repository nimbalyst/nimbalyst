// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { ContextUsageDisplay } from '../ContextUsageDisplay';

vi.mock('@nimbalyst/runtime', () => ({ MaterialSymbol: () => null }));
vi.mock('../../../help', () => ({ getHelpContent: () => undefined }));

// inputTokens > 0 makes the breakdown panel eligible (enableTooltip).
const props = {
  inputTokens: 80_000,
  outputTokens: 20_000,
  totalTokens: 100_000,
  contextWindow: 200_000,
  currentContext: { tokens: 132_000, contextWindow: 200_000 },
};

afterEach(() => cleanup());

describe('ContextUsageDisplay - context meter opens on click, not hover (#429)', () => {
  it('does NOT open the breakdown panel on hover', () => {
    render(<ContextUsageDisplay {...props} />);
    fireEvent.mouseEnter(screen.getByTestId('context-indicator'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('toggles the panel open and closed on click', () => {
    render(<ContextUsageDisplay {...props} />);
    const meter = screen.getByTestId('context-indicator');
    fireEvent.click(meter);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.click(meter);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes the panel on an outside click', () => {
    render(<ContextUsageDisplay {...props} />);
    fireEvent.click(screen.getByTestId('context-indicator'));
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes the panel on Escape', () => {
    render(<ContextUsageDisplay {...props} />);
    fireEvent.click(screen.getByTestId('context-indicator'));
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('exposes the meter as a button with aria-expanded when a breakdown exists', () => {
    render(<ContextUsageDisplay {...props} />);
    const meter = screen.getByTestId('context-indicator');
    expect(meter.getAttribute('role')).toBe('button');
    expect(meter.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(meter);
    expect(meter.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('ContextUsageDisplay - cumulative rows are labeled as session totals (#824)', () => {
  it('labels the io breakdown as cumulative session totals when the header shows window fill', () => {
    // Header-right shows current window fill (132k / 200k) while the io rows
    // show cumulative session usage (100k). Without a label the two read as
    // the same quantity and contradict each other (#824: 76k vs 12,073).
    render(<ContextUsageDisplay {...props} />);
    fireEvent.click(screen.getByTestId('context-indicator'));
    expect(screen.getByText('Session totals (cumulative)')).toBeTruthy();
  });

  it('omits the session-totals label when there is no context window (header already says Token Usage)', () => {
    // contextWindow: 0 is the no-window state (hasContextWindow derives from
    // displayContextWindow > 0); the header then reads "Token Usage" and no
    // window-fill total renders, so there is no second quantity to label.
    render(
      <ContextUsageDisplay
        inputTokens={80_000}
        outputTokens={20_000}
        totalTokens={100_000}
        contextWindow={0}
      />
    );
    fireEvent.click(screen.getByTestId('context-indicator'));
    expect(screen.queryByText('Session totals (cumulative)')).toBeNull();
  });
});
