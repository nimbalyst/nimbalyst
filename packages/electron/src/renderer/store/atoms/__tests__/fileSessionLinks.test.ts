// @vitest-environment node
import { expect, it, vi } from 'vitest';
import type { FileLink } from '@nimbalyst/runtime/ai/server/types';
import { createFileSessionLinksInvalidator, fileSessionLinkKey } from '../fileSessionLinks';

it('invalidates only changed file links, including removal and nested worktree equivalents', () => {
  const notify = vi.fn();
  const refresh = createFileSessionLinksInvalidator(notify);
  const file = (name: string, timestamp = 1): FileLink => ({
    id: name, sessionId: 'session', workspaceId: '/project_worktrees/feature/nested',
    filePath: name, linkType: 'edited', timestamp,
  });
  refresh('session', [file('a.md'), file('b.md')]);
  expect(notify.mock.calls).toEqual([['/project/a.md'], ['/project/b.md']]);
  notify.mockClear();
  refresh('session', [file('a.md'), file('b.md')]);
  expect(notify).not.toHaveBeenCalled();
  refresh('session', [file('a.md', 2), file('b.md')]);
  expect(notify).toHaveBeenCalledExactlyOnceWith('/project/a.md');
  notify.mockClear();
  refresh('session', [file('a.md', 2)]);
  expect(notify).toHaveBeenCalledExactlyOnceWith('/project/b.md');
  expect(fileSessionLinkKey('C:\\project_worktrees\\feature\\nested', 'C:\\project_worktrees\\feature\\nested\\a.md'))
    .toBe('C:/project/a.md');
  expect(fileSessionLinkKey('/project', '/project-other/a.md')).toBe('/project-other/a.md');
});
