import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workspaceRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const commandPaths = [
  '.claude/commands/design.md',
  'packages/extensions/planning/claude-plugin/commands/design.md',
];

describe.each(commandPaths)('%s', (commandPath) => {
  it('teaches the universal custom-editor embed contract', () => {
    const command = readFileSync(resolve(workspaceRoot, commandPath), 'utf8');

    expect(command).toContain('[Description](path/to/mockup.mockup.html "width=800 height=600")');
    expect(command).toContain('inspect the mounted plan surface');
    expect(command).not.toContain('](screenshot.png){mockup:path/to/mockup.mockup.html}');
  });
});
