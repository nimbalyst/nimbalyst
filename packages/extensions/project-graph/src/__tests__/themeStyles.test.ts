import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(
  resolve(process.cwd(), 'packages/extensions/project-graph/src/styles.css'),
  'utf8',
);

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  expect(match, `missing CSS rule for ${selector}`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('project graph theme surfaces', () => {
  it('maps its surface aliases to canonical Nimbalyst theme tokens', () => {
    const root = rule('.pg-root');

    expect(root).toContain('--pg-bg-0: var(--nim-bg)');
    expect(root).toContain('--pg-panel: var(--nim-bg-secondary)');
    expect(root).toContain('--pg-bg-3: var(--nim-bg-active)');
    expect(root).toContain('--pg-accent: var(--nim-primary)');
  });

  it.each([
    '.pg-toolbar-group',
    '.pg-label-pill',
    '.pg-canvas-zoom',
    '.pg-minimap',
    '.pg-legend',
    '.pg-canvas-tip',
    '.pg-node-tooltip',
  ])('themes the %s floating background instead of forcing a dark color', (selector) => {
    const declaration = rule(selector);

    expect(declaration).toMatch(/background:\s*var\(--pg-floating(?:-strong)?\)/);
    expect(declaration).not.toMatch(/background:\s*(?:#|rgba?\()/);
  });
});
