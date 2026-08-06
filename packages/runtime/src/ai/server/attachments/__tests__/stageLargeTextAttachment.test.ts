import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { AttachmentProcessor } from '../AttachmentProcessor';
import { stagedAttachmentRegistry } from '../stagedAttachmentRegistry';
import { prepareClaudeCodeAttachments } from '../../providers/claudeCode/messagePreparation';

const fixtures: string[] = [];

afterEach(async () => {
  stagedAttachmentRegistry.resetForTests();
  await Promise.all(fixtures.splice(0).map((fixture) => fs.rm(fixture, { recursive: true, force: true })));
});

describe('shared large-text attachment staging', () => {
  it('routes both runtime call sites through the same scoped root and filename shape', async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'large-attachment-'));
    fixtures.push(fixture);
    const stagingRoot = path.join(fixture, 'staging');
    const sourcePath = path.join(fixture, 'source.txt');
    const content = 'x'.repeat(11_000);
    await fs.writeFile(sourcePath, content, 'utf-8');

    const prepared = await prepareClaudeCodeAttachments({
      attachments: [{ type: 'document', filename: 'source.txt', filepath: sourcePath }],
      largeAttachmentCharThreshold: 10_000,
      stagingRoot,
      stagingMode: 'workspace',
      sessionId: 'session-a',
    });
    const [processed] = await new AttachmentProcessor({
      stagingRoot,
      stagingMode: 'workspace',
      sessionId: 'session-a',
    }).processAttachments([{
      id: 'attachment-a',
      filename: 'source.txt',
      filepath: sourcePath,
      mimeType: 'text/plain',
      size: content.length,
      type: 'document',
    }], { largeTextThreshold: 10_000 });

    const firstPath = prepared.largeAttachmentFilePaths[0].filepath;
    const secondPath = processed.tmpPath!;
    const expectedParent = path.join(stagingRoot, 'large', 'session-a');
    expect(path.dirname(firstPath)).toBe(expectedParent);
    expect(path.dirname(secondPath)).toBe(expectedParent);
    expect(path.basename(firstPath)).toMatch(/^nimbalyst-attachment-\d+-[a-f0-9]{16}-source\.txt$/);
    expect(path.basename(secondPath)).toMatch(/^nimbalyst-attachment-\d+-[a-f0-9]{16}-source\.txt$/);
    expect(firstPath).not.toBe(secondPath);
    await expect(fs.readFile(firstPath, 'utf-8')).resolves.toBe(content);
    await expect(fs.readFile(secondPath, 'utf-8')).resolves.toBe(content);
    expect(stagedAttachmentRegistry.find('session-a', firstPath)).toMatchObject({ mode: 'workspace' });
    expect(stagedAttachmentRegistry.find('session-a', secondPath)).toMatchObject({ mode: 'workspace' });
  });
});
