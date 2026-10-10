import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkArchiveWrites, findArchiveWrites } from '../check-session-archive-writes.mjs';

test('flags direct isArchived writes and ignores comments, strings, and other calls', () => {
  const flagged = [
    `window.electronAPI.invoke('sessions:update-metadata', id, { isArchived: true });`,
    `window.electronAPI.invoke('sessions:update-metadata', id, { isArchived });`,
    `electronAPI.invoke("sessions:update-metadata", id, { name: 'x', isArchived: false });`,
  ].join('\n');
  assert.deepEqual(findArchiveWrites(flagged, 'a.ts').map(hit => hit.line), [1, 2, 3]);
  const clean = [
    `// window.electronAPI.invoke('sessions:update-metadata', id, { isArchived: true });`,
    `const s = "invoke('sessions:update-metadata', id, { isArchived: true })";`,
    `invoke('sessions:update-metadata', id, { mode: 'agent' });`,
    `invoke('sessions:other', id, { isArchived: true });`,
  ].join('\n');
  assert.deepEqual(findArchiveWrites(clean, 'b.tsx'), []);
});

test('no renderer code writes isArchived directly', () => {
  assert.deepEqual(checkArchiveWrites(), []);
});
