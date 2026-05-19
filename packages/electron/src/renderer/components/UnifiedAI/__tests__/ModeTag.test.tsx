/**
 * ModeTag cycle + provider gating tests (issue #371).
 *
 * - claude-code: Plan -> Agent -> Auto -> Plan
 * - other providers: Plan <-> Agent (Auto unsupported, not surfaced)
 * - stale auto on non-claude-code session collapses to Plan visually
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModeTag, nextMode, type AIMode } from '../ModeTag';

vi.mock('../../../help', () => ({
  HelpTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('nextMode', () => {
  it('cycles Plan -> Agent -> Auto -> Plan for claude-code', () => {
    expect(nextMode('planning', 'claude-code')).toBe('agent');
    expect(nextMode('agent', 'claude-code')).toBe('auto');
    expect(nextMode('auto', 'claude-code')).toBe('planning');
  });

  it.each(['openai-codex', 'claude', 'lmstudio', 'opencode', 'copilot-cli', null, undefined])(
    'cycles Plan <-> Agent binary for non-claude-code provider=%s',
    (provider) => {
      expect(nextMode('planning', provider as string | null)).toBe('agent');
      expect(nextMode('agent', provider as string | null)).toBe('planning');
      // Stale `auto` on an unsupported provider is treated as if at index 0
      // (Plan) so a single click escapes to the next valid mode (Agent).
      expect(nextMode('auto', provider as string | null)).toBe('agent');
    },
  );
});

describe('ModeTag', () => {
  describe('claude-code provider', () => {
    it.each<[AIMode, string]>([
      ['planning', 'Plan'],
      ['agent', 'Agent'],
      ['auto', 'Auto'],
    ])('renders %s label for mode=%s', (mode, label) => {
      render(<ModeTag mode={mode} onModeChange={() => {}} provider="claude-code" />);
      expect(screen.getByRole('button').textContent).toBe(label);
    });

    it.each<[AIMode, AIMode]>([
      ['planning', 'agent'],
      ['agent', 'auto'],
      ['auto', 'planning'],
    ])('cycles from %s to %s on click', (from, to) => {
      const onModeChange = vi.fn();
      render(<ModeTag mode={from} onModeChange={onModeChange} provider="claude-code" />);
      fireEvent.click(screen.getByRole('button'));
      expect(onModeChange).toHaveBeenCalledWith(to);
    });

    it('Agent ARIA references Auto as next state', () => {
      render(<ModeTag mode="agent" onModeChange={() => {}} provider="claude-code" />);
      const aria = screen.getByRole('button').getAttribute('aria-label')!.toLowerCase();
      expect(aria).toContain('switch to auto mode');
    });
  });

  describe('non-claude-code provider', () => {
    it('renders Plan and Agent labels only, never Auto, even when mode=auto persisted', () => {
      const { rerender } = render(
        <ModeTag mode="planning" onModeChange={() => {}} provider="openai-codex" />,
      );
      expect(screen.getByRole('button').textContent).toBe('Plan');
      rerender(<ModeTag mode="agent" onModeChange={() => {}} provider="openai-codex" />);
      expect(screen.getByRole('button').textContent).toBe('Agent');
      // Stale auto must visually collapse to Plan (the provider cannot honor auto).
      rerender(<ModeTag mode="auto" onModeChange={() => {}} provider="openai-codex" />);
      expect(screen.getByRole('button').textContent).toBe('Plan');
    });

    it('Agent ARIA references Plan as next state (no Auto)', () => {
      render(<ModeTag mode="agent" onModeChange={() => {}} provider="openai-codex" />);
      const aria = screen.getByRole('button').getAttribute('aria-label')!.toLowerCase();
      expect(aria).toContain('switch to plan mode');
      expect(aria).not.toContain('auto');
    });

    it.each<[AIMode, AIMode]>([
      ['planning', 'agent'],
      ['agent', 'planning'],
    ])('cycles binary from %s to %s on click', (from, to) => {
      const onModeChange = vi.fn();
      render(<ModeTag mode={from} onModeChange={onModeChange} provider="openai-codex" />);
      fireEvent.click(screen.getByRole('button'));
      expect(onModeChange).toHaveBeenCalledWith(to);
    });

    it('clicking when stale auto persisted advances to agent', () => {
      const onModeChange = vi.fn();
      render(<ModeTag mode="auto" onModeChange={onModeChange} provider="openai-codex" />);
      fireEvent.click(screen.getByRole('button'));
      // Visible mode is Plan (auto collapsed). Cycle advances to Agent.
      expect(onModeChange).toHaveBeenCalledWith('agent');
    });
  });

  it('emits data-mode attribute matching the visible mode', () => {
    const { rerender } = render(
      <ModeTag mode="planning" onModeChange={() => {}} provider="claude-code" />,
    );
    expect(screen.getByRole('button').getAttribute('data-mode')).toBe('planning');
    rerender(<ModeTag mode="auto" onModeChange={() => {}} provider="claude-code" />);
    expect(screen.getByRole('button').getAttribute('data-mode')).toBe('auto');
    // Non-claude-code with stale auto -> data-mode reflects the visible Plan.
    rerender(<ModeTag mode="auto" onModeChange={() => {}} provider="openai-codex" />);
    expect(screen.getByRole('button').getAttribute('data-mode')).toBe('planning');
  });
});
