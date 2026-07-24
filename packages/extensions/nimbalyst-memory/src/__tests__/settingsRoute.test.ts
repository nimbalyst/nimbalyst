import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface MemoryManifest {
  contributions?: {
    settingsPanel?: unknown;
    settingsRoutes?: unknown[];
  };
}

const manifest = JSON.parse(
  readFileSync(
    path.join(process.cwd(), 'packages/extensions/nimbalyst-memory/manifest.json'),
    'utf8',
  ),
) as MemoryManifest;

describe('Nimbalyst Memory settings contribution', () => {
  it('registers Memory as a first-class Project settings route only', () => {
    expect(manifest.contributions?.settingsPanel).toBeUndefined();
    expect(manifest.contributions?.settingsRoutes).toEqual([
      {
        id: 'memory',
        scope: 'project',
        label: 'Memory',
        group: 'Project',
        icon: 'psychology',
        order: 80,
        component: 'NimbalystMemorySettings',
      },
    ]);
  });
});
