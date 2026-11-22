// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { panelsVisibleInMode } from '../panelVisibility';

const panels = [
  { id: 'com.nimbalyst.git.git-log', extensionId: 'com.nimbalyst.git' },
  { id: 'com.nimbalyst.run.runs', extensionId: 'com.nimbalyst.run' },
];
const manifests = [
  { id: 'com.nimbalyst.git' },
  { id: 'com.nimbalyst.run', requiresDeveloperMode: true },
];

describe('panelsVisibleInMode', () => {
  it('hides panels of requiresDeveloperMode extensions while Developer Mode is off', () => {
    expect(panelsVisibleInMode(panels, manifests, false).map((p) => p.id)).toEqual(['com.nimbalyst.git.git-log']);
  });

  it('shows every panel while Developer Mode is on', () => {
    expect(panelsVisibleInMode(panels, manifests, true)).toHaveLength(2);
  });
});
