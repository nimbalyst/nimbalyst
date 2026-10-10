import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutputTab } from '../components/OutputTab';
import type { OperationLogEntry } from '../hooks/useOperationLog';

function entry(id: string, output = 'Fetching objects'): OperationLogEntry {
  return {
    id, output, timestamp: new Date(0), updatedAt: 0,
    command: 'git fetch', executable: 'git', args: ['fetch'], cwd: '/repo',
    status: 'running', stdout: output, stderr: '',
  };
}

describe('OutputTab scrolling', () => {
  let height: number;

  beforeEach(() => {
    height = 1000;
    // jsdom has no layout: supply viewport geometry and browser scroll clamping.
    const positions = new WeakMap<HTMLElement, number>();
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => height);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) {
      return positions.get(this) ?? 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) {
      positions.set(this, Math.max(0, Math.min(value, height - 200)));
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('follows output until scrolled up, preserves the reading position, and resumes at the bottom', () => {
    const onClear = vi.fn();
    const { container, rerender } = render(<OutputTab entries={[entry('1')]} onClear={onClear} />);
    const scroll = container.querySelector<HTMLDivElement>('.git-output-scroll')!;
    expect(scroll.scrollTop).toBe(800);

    height = 1200;
    rerender(<OutputTab entries={[entry('1', 'More output')]} onClear={onClear} />);
    expect(scroll.scrollTop).toBe(1000);

    scroll.scrollTop = 400;
    fireEvent.scroll(scroll);
    height = 1400;
    rerender(<OutputTab entries={[entry('1', 'Streaming output')]} onClear={onClear} />);
    expect(scroll.scrollTop).toBe(400);
    height = 1600;
    rerender(<OutputTab entries={[entry('1'), entry('2')]} onClear={onClear} />);
    expect(scroll.scrollTop).toBe(400);

    // Fractional scroll positions can leave a subpixel gap at the bottom.
    scroll.scrollTop = 1399.5;
    fireEvent.scroll(scroll);
    height = 1800;
    rerender(<OutputTab entries={[entry('1'), entry('2', 'More output')]} onClear={onClear} />);
    expect(scroll.scrollTop).toBe(1600);
  });

  it('starts following again after the log is cleared while scrolled up', () => {
    const onClear = vi.fn();
    const { container, rerender } = render(<OutputTab entries={[entry('1')]} onClear={onClear} />);
    const scroll = container.querySelector<HTMLDivElement>('.git-output-scroll')!;
    scroll.scrollTop = 100;
    fireEvent.scroll(scroll);
    rerender(<OutputTab entries={[]} onClear={onClear} />);
    rerender(<OutputTab entries={[entry('2')]} onClear={onClear} />);
    expect(container.querySelector('.git-output-scroll')!.scrollTop).toBe(800);
  });
});
