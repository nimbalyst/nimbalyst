// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import os from 'os';
import path from 'path';
import { parseCommandFile, parseSkillFile } from '../CommandFileParser';

describe('CommandFileParser frontmatter diagnostics', () => {
  const directories: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each([parseCommandFile, parseSkillFile])('warns without a stack and preserves malformed content (%#)', (parse) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'command-parser-'));
    directories.push(directory);
    const file = path.join(directory, 'SKILL.md');
    const content = '---\nname: start\ndescription: Start using Wiki: show how\n---\nBody';
    fs.writeFileSync(file, content);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parse(file, 'project')?.content).toBe(content);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      `[CommandFileParser] Invalid YAML frontmatter in ${file}: bad indentation of a mapping entry (line 3, column 30)`,
    );
  });

  it.each(['start', 'team'])('parses the bundled wiki %s skill metadata', (name) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const skill = parseSkillFile(path.resolve('plugins/nimbalyst-wiki/skills', name, 'SKILL.md'), 'plugin');
    expect(skill?.name).toBe(name);
    expect(skill?.description).toMatch(name === 'start' ? /^Start using Nimbalyst Wiki:/ : /^Put this project's wiki on Nimbalyst Teams:/);
    expect(skill?.argumentHint).toBeDefined();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
