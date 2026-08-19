// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describeUnusableWorkspacePath } from '../workspacePreconditions';

describe('describeUnusableWorkspacePath', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-precondition-'));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('accepts a directory that exists', () => {
    expect(describeUnusableWorkspacePath(tempDir)).toBeNull();
  });

  // The reason this check exists: Node reports a missing cwd as an ENOENT
  // naming the *command*, so without it the user is told the bundled agent
  // binary is broken. The message must name the folder instead.
  it('names the missing folder when the path is gone', () => {
    const missing = path.join(tempDir, 'moved-away');
    const message = describeUnusableWorkspacePath(missing);
    expect(message).toContain(missing);
    expect(message).toMatch(/no longer exists/i);
  });

  it('rejects a path that is a file rather than a folder', () => {
    const filePath = path.join(tempDir, 'not-a-dir.txt');
    fs.writeFileSync(filePath, 'x');
    expect(describeUnusableWorkspacePath(filePath)).toMatch(/not a folder/i);
  });

  it('reports a missing path when none is set', () => {
    expect(describeUnusableWorkspacePath(undefined)).toMatch(/no project folder/i);
  });
});
