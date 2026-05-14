import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { prepareClaudeCodeAttachments } from '../messagePreparation';

// Regression coverage for nimbalyst#269. TaiwanTammy reported that when a
// pasted-text attachment exceeded the inline threshold, the message sent to
// the agent included a path like `\tmp\nimbalyst-attachment-...txt` on
// Windows -- a POSIX path with a backslash root that Windows cannot resolve.
// The agent then wasted turns globbing the workspace, AppData\Local\Temp,
// and Downloads, eventually giving up with "the pasted text file doesn't
// exist on disk." Root cause: `path.join('/tmp', ...)` was hardcoded in the
// claude-code attachment preparation, while AttachmentProcessor already used
// `os.tmpdir()`. This test pins the cross-platform behaviour.

describe('prepareClaudeCodeAttachments large-document tmpdir (issue #269)', () => {
  const cleanupPaths: string[] = [];

  beforeEach(() => {
    cleanupPaths.length = 0;
  });

  afterEach(async () => {
    // Clean up any files written by the suite -- the production code path
    // intentionally leaves them on disk for the agent's Read tool, so the
    // test takes responsibility for unlinking them.
    for (const p of cleanupPaths) {
      try { await fs.unlink(p); } catch { /* ignore */ }
    }
  });

  it('writes large documents to os.tmpdir() (not hardcoded /tmp)', async () => {
    // Build a source file just over the inline threshold so the code takes
    // the "write to tmp" branch instead of inlining as a document block.
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-269-source-'));
    const sourcePath = path.join(sourceDir, 'pasted-text-12345.txt');
    const longContent = 'x'.repeat(11_000); // > default 10_000 threshold
    await fs.writeFile(sourcePath, longContent, 'utf-8');

    try {
      const result = await prepareClaudeCodeAttachments({
        attachments: [
          { type: 'document', filename: 'pasted-text-12345.txt', filepath: sourcePath },
        ],
        largeAttachmentCharThreshold: 10_000,
      });

      expect(result.largeAttachmentFilePaths).toHaveLength(1);
      const writtenPath = result.largeAttachmentFilePaths[0].filepath;
      cleanupPaths.push(writtenPath);

      // The written path must start with the platform's tmpdir, not a literal
      // '/tmp'. On Windows os.tmpdir() returns something like
      // `C:\Users\<user>\AppData\Local\Temp`; on macOS / Linux it returns
      // `/var/folders/.../T` or `/tmp`. Either way, the prefix is correct
      // for the current platform and the path is resolvable.
      expect(writtenPath.startsWith(os.tmpdir())).toBe(true);
      expect(path.isAbsolute(writtenPath)).toBe(true);

      // The file actually exists at that path. Without this assertion a
      // future refactor could regress to building the path correctly but
      // failing to write the contents, which would manifest the same way
      // to the user.
      const written = await fs.readFile(writtenPath, 'utf-8');
      expect(written).toBe(longContent);
    } finally {
      await fs.unlink(sourcePath).catch(() => {});
      await fs.rmdir(sourceDir).catch(() => {});
    }
  });

  it('preserves the small-document inline path (regression guard)', async () => {
    // Verify the under-threshold branch still emits a document content
    // block and does NOT write to tmpdir. Otherwise a misguided fix could
    // route every document through the tmp file, defeating the inline
    // performance optimisation.
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-269-small-'));
    const sourcePath = path.join(sourceDir, 'small.txt');
    const shortContent = 'just a few characters';
    await fs.writeFile(sourcePath, shortContent, 'utf-8');

    try {
      const result = await prepareClaudeCodeAttachments({
        attachments: [
          { type: 'document', filename: 'small.txt', filepath: sourcePath },
        ],
        largeAttachmentCharThreshold: 10_000,
      });

      expect(result.largeAttachmentFilePaths).toHaveLength(0);
      expect(result.documentContentBlocks).toHaveLength(1);
      expect(result.documentContentBlocks[0]).toMatchObject({
        type: 'document',
        source: {
          type: 'text',
          media_type: 'text/plain',
          data: shortContent,
        },
        title: 'small.txt',
      });
    } finally {
      await fs.unlink(sourcePath).catch(() => {});
      await fs.rmdir(sourceDir).catch(() => {});
    }
  });
});
