// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest may transform a worktree test through the shared package cache. Read
// from the active checkout so this regression assertion always evaluates the
// branch under test rather than that cache's source tree.
const source = readFileSync(
  resolve(process.cwd(), 'packages/electron/src/main/services/ai/AIService.ts'),
  'utf8',
);
const start = source.indexOf("safeHandle('ai:createQueuedPrompt'");
const end = source.indexOf("safeHandle('ai:deleteQueuedPrompt'", start);
const createQueuedPromptHandler = source.slice(start, end);

describe('ai:createQueuedPrompt queue-drive admission', () => {
  it('raises the provider-neutral queue-drive edge after persisting a prompt', () => {
    expect(createQueuedPromptHandler).not.toContain("queuedSession?.provider === 'claude-code-cli'");
    expect(createQueuedPromptHandler).toContain(
      "this.requestQueueDrive(sessionId, queuedSession.workspacePath, 'renderer-trigger')",
    );
  });
});
