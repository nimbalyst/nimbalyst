import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testComprehensiveDiff } from './comprehensiveDiffTester';

export function largeDocumentDiff(fixture: string) {
  const directory = join(__dirname, '../unit/larger');
  const oldMarkdown = readFileSync(join(directory, `${fixture}-old.md`), 'utf8');
  const newMarkdown = readFileSync(join(directory, `${fixture}-new.md`), 'utf8');
  return { oldMarkdown, newMarkdown, result: testComprehensiveDiff(oldMarkdown, newMarkdown) };
}
