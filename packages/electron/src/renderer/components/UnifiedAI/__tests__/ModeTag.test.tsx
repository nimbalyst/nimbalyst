/**
 * ModeTag cycle tests (issue #371).
 *
 * User-facing toggle is always Plan <-> Agent. Auto mode is activated
 * transparently via the "Allow All" trust level and does not appear in
 * the toggle cycle.
 *
 * Stale `auto` from older sessions collapses to Agent visually.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModeTag, nextMode, buildModeList, type AIMode } from '../ModeTag';

vi.mock('../../../help', () => ({
  HelpTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('buildModeList', () => {
  it('returns [planning, agent] regardless of provider', () => {
    expect(buildModeList('claude-code')).toEqual(['planning', 'agent']);
    expect(buildModeList('openai-codex')).toEqual(['planning', 'agent']);
    expect(buildModeList(null)).toEqual(['planning', 'agent']);
    expect(buildModeList(undefined)).toEqual(['planning', 'agent']);
  });
});

describe('nextMode', () => {
  it('cycles Plan -> Agent -> Plan', () => {
    expect(nextMode('planning', 'claude-code')).toBe('agent');
    expect(nextMode('agent', 'claude-code')).toBe('planning');
  });

  it('stale auto collapses to index 0 and advances to agent', () => {
    expect(nextMode('auto', 'claude-code')).toBe('agent');
    expect(nextMode('auto', null)).toBe('agent');
  });

  it.each(['openai-codex', 'claude', 'lmstudio', null, undefined])(
    'cycles Plan <-> Agent for provider=%s',
    (provider) => {
      expect(nextMode('planning', provider as string | null)).toBe('agent');
      expect(nextMode('agent', provider as string | null)).toBe('planning');
    },
  );
});

describe('ModeTag', () => {
  it.each<[AIMode, string]>([
    ['planning', 'Plan'],
    ['agent', 'Agent'],
  ])('renders %s label for mode=%s', (mode, label) => {
    render(<ModeTag mode={mode} onModeChange={() => {}} provider="claude-code" />);
    expect(screen.getByRole('button').textContent).toBe(label);
  });

  it('stale auto renders as Agent', () => {
    render(<ModeTag mode="auto" onModeChange={() => {}} provider="claude-code" />);
    expect(screen.getByRole('button').textContent).toBe('Agent');
  });

  it.each<[AIMode, AIMode]>([
    ['planning', 'agent'],
    ['agent', 'planning'],
  ])('cycles from %s to %s on click', (from, to) => {
    const onModeChange = vi.fn();
    render(<ModeTag mode={from} onModeChange={onModeChange} provider="claude-code" />);
    fireEvent.click(screen.getByRole('button'));
    expect(onModeChange).toHaveBeenCalledWith(to);
  });

  it('clicking when stale auto advances to planning (wraps from agent)', () => {
    const onModeChange = vi.fn();
    render(<ModeTag mode="auto" onModeChange={onModeChange} provider="claude-code" />);
    fireEvent.click(screen.getByRole('button'));
    expect(onModeChange).toHaveBeenCalledWith('planning');
  });

  it('Agent ARIA references Plan as next state', () => {
    render(<ModeTag mode="agent" onModeChange={() => {}} provider="claude-code" />);
    const aria = screen.getByRole('button').getAttribute('aria-label')!.toLowerCase();
    expect(aria).toContain('switch to plan mode');
    expect(aria).not.toContain('auto');
  });

  it('emits data-mode matching visible mode', () => {
    const { rerender } = render(
      <ModeTag mode="planning" onModeChange={() => {}} provider="claude-code" />,
    );
    expect(screen.getByRole('button').getAttribute('data-mode')).toBe('planning');
    rerender(<ModeTag mode="agent" onModeChange={() => {}} provider="claude-code" />);
    expect(screen.getByRole('button').getAttribute('data-mode')).toBe('agent');
    rerender(<ModeTag mode="auto" onModeChange={() => {}} provider="claude-code" />);
    expect(screen.getByRole('button').getAttribute('data-mode')).toBe('agent');
  });
});
