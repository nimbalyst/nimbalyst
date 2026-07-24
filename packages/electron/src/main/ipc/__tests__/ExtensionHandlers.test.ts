import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { buildExtensionFindFilesPlan } from '../extensionFindFilesPlan';

describe('buildExtensionFindFilesPlan', () => {
  const workspacePath = path.resolve('/tmp/workspace');

  it('scopes scans to the literal directory prefix before the first glob', () => {
    const plan = buildExtensionFindFilesPlan(
      workspacePath,
      'nimbalyst-local/automations/*.md'
    );

    expect(plan.normalizedPattern).toBe('nimbalyst-local/automations/*.md');
    expect(plan.scanRoot).toBe(path.join(workspacePath, 'nimbalyst-local', 'automations'));
  });

  it('keeps the workspace root when the pattern starts with a glob', () => {
    const plan = buildExtensionFindFilesPlan(workspacePath, '**/*.md');

    expect(plan.scanRoot).toBe(workspacePath);
  });

  it('stops at the first globbed segment and keeps only the static prefix', () => {
    const plan = buildExtensionFindFilesPlan(
      workspacePath,
      'src/*/fixtures/*.json'
    );

    expect(plan.scanRoot).toBe(path.join(workspacePath, 'src'));
  });

  it('normalizes windows separators before deriving the scan root', () => {
    const plan = buildExtensionFindFilesPlan(
      workspacePath,
      'nimbalyst-local\\automations\\*.md'
    );

    expect(plan.normalizedPattern).toBe('nimbalyst-local/automations/*.md');
    expect(plan.scanRoot).toBe(path.join(workspacePath, 'nimbalyst-local', 'automations'));
  });
});
