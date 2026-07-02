import { describe, it, expect, vi } from 'vitest';

// RewindSessionService imports `electron` at module load (BrowserWindow for the
// reparse broadcast). Stub it so the module loads in the node test env.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import { buildRewindContextPrefix } from '../RewindSessionService';

describe('buildRewindContextPrefix', () => {
  it('returns null when there are no turns', () => {
    expect(buildRewindContextPrefix([])).toBeNull();
  });

  it('returns null when all turns are blank', () => {
    expect(
      buildRewindContextPrefix([
        { role: 'user', text: '   ' },
        { role: 'assistant', text: '' },
      ]),
    ).toBeNull();
  });

  it('renders user/assistant turns with a header and trailing separator', () => {
    const prefix = buildRewindContextPrefix([
      { role: 'user', text: 'build a login form' },
      { role: 'assistant', text: 'Done, added LoginForm.tsx' },
    ]);
    expect(prefix).toContain('User: build a login form');
    expect(prefix).toContain('Assistant: Done, added LoginForm.tsx');
    expect(prefix).toMatch(/---\n\n$/);
    expect(prefix).not.toContain('[earlier turns omitted]');
  });

  it('omits and marks earlier turns when over the bound', () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `turn ${i}`,
    }));
    const prefix = buildRewindContextPrefix(turns, 6);
    expect(prefix).toContain('[earlier turns omitted]');
    // Only the last 6 turns survive.
    expect(prefix).toContain('turn 19');
    expect(prefix).toContain('turn 14');
    expect(prefix).not.toContain('turn 13');
    expect(prefix).not.toContain('turn 0');
  });

  it('skips blank turns but keeps surrounding content', () => {
    const prefix = buildRewindContextPrefix([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: '   ' },
      { role: 'user', text: 'second' },
    ]);
    expect(prefix).toContain('User: first');
    expect(prefix).toContain('User: second');
    // The blank assistant turn produces no "Assistant:" line.
    expect(prefix).not.toContain('Assistant:');
  });
});
