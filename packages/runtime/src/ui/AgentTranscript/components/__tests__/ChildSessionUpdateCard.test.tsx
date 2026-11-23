// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChildSessionUpdateCard } from '../ChildSessionUpdateCard';
import { parseChildSessionUpdate } from '../../utils/parseChildSessionUpdate';

afterEach(cleanup);

describe('child report disclosure', () => {
  it('keeps questions visible and only mounts exact file links when opened', () => {
    const paths = ['C:\\Users\\Egor Sokolov\\текст.md', 'packages\\.claude\\settings.json', 'LICENSE'];
    const text = '[Child Session Update]\nSession: "Worker" (child)\nStatus: waiting_for_input\nEvent: session:waiting\nRecent messages:\n- Assistant: Done\nFiles modified:\n'
      + paths.map(path => '- ' + path).join('\n') + '\n\nACTION REQUIRED: answer\n  promptId: abc';
    const display = parseChildSessionUpdate(text)!;
    const onOpenFile = vi.fn();
    const onOpenSession = vi.fn();
    render(<ChildSessionUpdateCard display={display} onOpenFile={onOpenFile} onOpenSession={onOpenSession} />);
    expect(screen.queryByText(paths[0])).toBeNull();
    expect(screen.getByText(/ACTION REQUIRED/).textContent).toContain('\n');
    fireEvent.click(screen.getByRole('button', { name: 'Worker' }));
    expect(onOpenSession).toHaveBeenCalledWith('child');
    const toggle = screen.getByRole('button', { name: /Files modified/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    paths.forEach(path => {
      const link = screen.getByRole('link', { name: path });
      expect(link.getAttribute('data-transcript-file-path')).toBe(path);
      expect(link.getAttribute('href')).toBe('#');
      fireEvent.click(link);
      expect(onOpenFile).toHaveBeenLastCalledWith(path);
    });
    fireEvent.click(toggle);
    expect(screen.queryByText(paths[0])).toBeNull();
    expect(screen.getByText(/ACTION REQUIRED/).textContent).toContain('promptId: abc');
  });
});
