import { describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import { attachmentPathMatchesDenyRule, findAttachmentDenyRule } from '../attachmentDenyMatcher';

describe('attachmentDenyMatcher', () => {
  it.each([
    ['C:\\Users\\Ada\\AppData\\Local\\Temp\\nimbalyst-attachment-1.txt', 'Read(**/AppData/**)'],
    ['C:\\Users\\Ada\\AppData\\Local\\Temp\\nimbalyst-attachment-1.txt', 'Read(**/AppData/Local/Temp/nimbalyst-attachment-*)'],
    ['C:\\Users\\Ada\\AppData\\Roaming\\nimbalyst\\saved\\image.png', 'Write(**/AppData/**)'],
  ])('matches Windows candidate %s against %s', (candidate, rule) => {
    expect(attachmentPathMatchesDenyRule(candidate, rule)).toBe(true);
  });

  it('expands home rules', () => {
    const candidate = path.join(os.homedir(), '.private', 'attachment.txt');
    expect(attachmentPathMatchesDenyRule(candidate, 'Edit(~/.private/**)')).toBe(true);
  });

  it.each([
    ['/workspace/project/report.txt', 'Read(**/AppData/**)'],
    ['C:\\Users\\Ada\\Documents\\report.txt', 'Read(**/AppData/**)'],
    ['C:\\Users\\Ada\\AppData\\Local\\Temp\\other.txt', 'Read(**/AppData/Local/Temp/nimbalyst-attachment-*)'],
    ['C:\\Users\\Ada\\AppData\\Local\\Temp\\nimbalyst-attachment-1.txt', 'Bash(**/AppData/**)'],
  ])('does not over-match candidate %s against %s', (candidate, rule) => {
    expect(attachmentPathMatchesDenyRule(candidate, rule)).toBe(false);
  });

  it('returns the matching effective deny rule', () => {
    expect(findAttachmentDenyRule(
      'C:\\Users\\Ada\\AppData\\Local\\Temp\\attachment.txt',
      ['Read(**/.ssh/**)', 'Read(**/AppData/**)'],
    )).toBe('Read(**/AppData/**)');
  });
});
