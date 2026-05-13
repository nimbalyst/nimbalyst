import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../../../../');

function collectMarkdownFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const results: string[] = [];

  const walk = (currentPath: string) => {
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
  };

  walk(dirPath);
  return results.sort();
}

function hasDescriptionFrontmatter(filePath: string): boolean {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) {
    return false;
  }
  return /^description:\s*.+$/m.test(match[1]);
}

describe('workflow command metadata', () => {
  it('keeps project Claude commands described for export compatibility', () => {
    const commandFiles = collectMarkdownFiles(path.join(repoRoot, '.claude', 'commands'));
    const missing = commandFiles.filter((filePath) => !hasDescriptionFrontmatter(filePath));

    expect(missing).toEqual([]);
  });

  it('keeps built-in extension Claude plugin commands described', () => {
    const extensionRoot = path.join(repoRoot, 'packages', 'extensions');
    const pluginCommandFiles = collectMarkdownFiles(extensionRoot).filter((filePath) =>
      filePath.includes(`${path.sep}claude-plugin${path.sep}`) &&
      !filePath.endsWith(`${path.sep}SKILL.md`)
    );
    const missing = pluginCommandFiles.filter((filePath) => !hasDescriptionFrontmatter(filePath));

    expect(missing).toEqual([]);
  });
});
