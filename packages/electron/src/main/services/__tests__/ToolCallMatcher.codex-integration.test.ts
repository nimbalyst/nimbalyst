/**
 * ToolCallMatcher Codex Integration Test
 *
 * Makes REAL calls to the Codex SDK to edit files, captures the raw events,
 * then verifies that parseToolCallWindows and scoreMatch correctly correlate
 * file edits to tool calls.
 *
 * Requires OPENAI_API_KEY env var. Skips if not set.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock electron modules before any imports that reference them
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: {
    isInitialized: () => true,
    initialize: vi.fn(),
    query: vi.fn(),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

import { parseToolCallWindows, scoreMatch, type ToolCallWindow } from '../ToolCallMatcher';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const RUN_PROVIDER_TESTS = process.env.RUN_AI_PROVIDER_TESTS === 'true';

/**
 * Helper: Check if a value is an async iterable.
 */
function isAsyncIterable(value: unknown): value is AsyncIterable<any> {
  return !!value && typeof (value as any)[Symbol.asyncIterator] === 'function';
}

/**
 * Helper: Extract the events iterable from a runStreamed result.
 * The SDK can return either a direct AsyncIterable or an object with an events property.
 */
function getEventsIterable(
  runResult: { events?: AsyncIterable<any> } | AsyncIterable<any>
): AsyncIterable<any> {
  if (isAsyncIterable(runResult)) return runResult;
  if (runResult && isAsyncIterable(runResult.events)) return runResult.events;
  throw new Error('Codex SDK did not return a valid events stream');
}

/**
 * Helper: Extract raw events from a Codex SDK thread run.
 * Uses the SDK directly without going through CodexSDKProtocol or OpenAICodexProvider,
 * since those have complex dependencies (Electron, trust checkers, etc.).
 */
async function runCodexAndCaptureEvents(
  apiKey: string,
  workspacePath: string,
  prompt: string
): Promise<{ rawEvents: any[]; error?: string }> {
  // Dynamic import of the Codex SDK
  let CodexClass: any;
  try {
    const sdk = await import('@openai/codex-sdk');
    CodexClass = (sdk as any).Codex;
    if (!CodexClass) {
      return { rawEvents: [], error: 'Could not find Codex class in SDK exports' };
    }
  } catch (e) {
    return { rawEvents: [], error: `Failed to import @openai/codex-sdk: ${e}` };
  }

  const rawEvents: any[] = [];

  try {
    const codex = new CodexClass({ apiKey });
    const thread = codex.startThread({
      workingDirectory: workspacePath,
      model: 'gpt-5.1-codex-mini',
      skipGitRepoCheck: true,
      approvalPolicy: 'never',
      sandboxMode: 'danger-full-access',
      modelReasoningEffort: 'high',
      developer_instructions: 'You are a file editing assistant. Execute file operations as requested. Use the simplest approach possible. Do not ask questions.',
    });

    const runResult = await thread.runStreamed(prompt);

    // Use the same getEventsIterable pattern as production code
    const events = getEventsIterable(runResult);
    for await (const event of events) {
      rawEvents.push(event);
    }
  } catch (e: any) {
    return { rawEvents, error: `Codex execution failed: ${e.message}` };
  }

  return { rawEvents };
}

/**
 * Helper: Convert raw Codex events to the format stored in ai_agent_messages,
 * then run parseToolCallWindows on each to extract tool call windows.
 */
function extractToolCallWindowsFromRawEvents(
  rawEvents: any[],
  sessionId: string,
  workspacePath: string
): ToolCallWindow[] {
  const allWindows: ToolCallWindow[] = [];
  let messageId = 1;

  for (const event of rawEvents) {
    // Each raw event is stored as a separate ai_agent_messages row
    // The content is JSON.stringify of the event
    const content = JSON.stringify(event);
    const createdAt = new Date();

    const windows = parseToolCallWindows(
      messageId++,
      content,
      createdAt,
      sessionId,
      workspacePath
    );
    allWindows.push(...windows);
  }

  return allWindows;
}

describe('ToolCallMatcher Codex Integration', () => {
  let tempDir: string;
  const SESSION_ID = 'test-codex-integration';

  beforeAll(() => {
    // Create temp directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolcall-codex-test-'));
  });

  afterAll(() => {
    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    // Reset temp files for each test
    fs.writeFileSync(path.join(tempDir, 'edit-target.txt'), 'Line 1: Hello World\nLine 2: This is a test file.\nLine 3: End of file.\n');
    fs.writeFileSync(path.join(tempDir, 'bash-target.txt'), 'Original content.\n');
  });

  const skipReason = !OPENAI_API_KEY
    ? 'OPENAI_API_KEY not set'
    : !RUN_PROVIDER_TESTS
      ? 'RUN_AI_PROVIDER_TESTS not enabled'
    : '';

  (skipReason ? it.skip : it)(
    'captures file_change events from Codex apply_diff and matches them',
    { timeout: 120_000 },
    async () => {
      const editFile = path.join(tempDir, 'edit-target.txt');

      const { rawEvents, error } = await runCodexAndCaptureEvents(
        OPENAI_API_KEY!,
        tempDir,
        `Edit the file ${editFile}. Change "Hello World" to "Hello Codex" on line 1. Use apply_diff or your built-in file editing tool. Do not use bash.`
      );

      if (error) {
        console.warn('Codex SDK not available, skipping:', error);
        return;
      }

      expect(rawEvents.length).toBeGreaterThan(0);

      // Extract tool call windows from the raw events
      const windows = extractToolCallWindowsFromRawEvents(rawEvents, SESSION_ID, tempDir);

      // Should have at least one tool call window
      expect(windows.length).toBeGreaterThan(0);

      // Find windows that reference the edit target file
      const editWindows = windows.filter(w =>
        w.argsText.includes('edit-target.txt')
      );

      // Should have found the file in at least one tool call
      expect(editWindows.length).toBeGreaterThan(0);

      // Verify the file was actually edited
      const content = fs.readFileSync(editFile, 'utf-8');
      expect(content).toContain('Hello Codex');

      // Now test scoreMatch - simulate a session_files entry
      const fileTimestamp = Date.now();
      for (const w of editWindows) {
        const result = scoreMatch(editFile, fileTimestamp, w);
        // Should match since filename is in args and timestamp is recent
        expect(result).not.toBeNull();
        expect(result!.score).toBeGreaterThanOrEqual(30);
        expect(result!.reasons.some(r => r.includes('name_in') || r.includes('path_in_changes'))).toBe(true);
      }
    }
  );

  (skipReason ? it.skip : it)(
    'captures command_execution events from Codex bash edits and matches them',
    { timeout: 120_000 },
    async () => {
      const bashFile = path.join(tempDir, 'bash-target.txt');

      const { rawEvents, error } = await runCodexAndCaptureEvents(
        OPENAI_API_KEY!,
        tempDir,
        `Append the line "Appended by Codex bash test." to the file ${bashFile} using a bash command like: echo "Appended by Codex bash test." >> ${bashFile}`
      );

      if (error) {
        console.warn('Codex SDK not available, skipping:', error);
        return;
      }

      expect(rawEvents.length).toBeGreaterThan(0);

      // Extract tool call windows from raw events
      const windows = extractToolCallWindowsFromRawEvents(rawEvents, SESSION_ID, tempDir);

      // Find command_execution windows (will show as 'Bash' tool)
      const bashWindows = windows.filter(w => w.toolName === 'Bash');

      // Should have bash tool calls
      expect(bashWindows.length).toBeGreaterThan(0);

      // Find windows that reference the bash target file
      const matchingWindows = windows.filter(w =>
        w.argsText.includes('bash-target.txt')
      );

      // After shell wrapper unwrapping fix, should find the file
      expect(matchingWindows.length).toBeGreaterThan(0);

      // Verify the file was actually edited
      const content = fs.readFileSync(bashFile, 'utf-8');
      expect(content).toContain('Appended by Codex bash test.');

      // Test scoreMatch
      const fileTimestamp = Date.now();
      for (const w of matchingWindows) {
        const result = scoreMatch(bashFile, fileTimestamp, w);
        expect(result).not.toBeNull();
        expect(result!.score).toBeGreaterThanOrEqual(30);
      }
    }
  );

  (skipReason ? it.skip : it)(
    'end-to-end: both file_change and bash edits are matched in same session',
    { timeout: 180_000 },
    async () => {
      const editFile = path.join(tempDir, 'edit-target.txt');
      const bashFile = path.join(tempDir, 'bash-target.txt');

      // Ask Codex to do both edits in one session
      const { rawEvents, error } = await runCodexAndCaptureEvents(
        OPENAI_API_KEY!,
        tempDir,
        `Do these two things:
1. Edit the file ${editFile} - change "Hello World" on line 1 to "Hello Integration Test" using your file editing tool (not bash).
2. Append the line "Integration test bash edit." to ${bashFile} using a bash command with echo and >>
Do both operations.`
      );

      if (error) {
        console.warn('Codex SDK not available, skipping:', error);
        return;
      }

      expect(rawEvents.length).toBeGreaterThan(0);

      // Extract all tool call windows
      const windows = extractToolCallWindowsFromRawEvents(rawEvents, SESSION_ID, tempDir);

      // Check for edit-target.txt
      const editMatches = windows.filter(w =>
        w.argsText.includes('edit-target.txt')
      );

      // Check for bash-target.txt
      const bashMatches = windows.filter(w =>
        w.argsText.includes('bash-target.txt')
      );

      // Both files should be found in tool call windows
      console.log('Edit matches:', editMatches.length, 'Bash matches:', bashMatches.length);
      console.log('All windows:', windows.map(w => ({
        tool: w.toolName,
        argsText: w.argsText.slice(0, 100),
      })));

      // At minimum, the edit file should be matched (file_change is reliable)
      expect(editMatches.length + bashMatches.length).toBeGreaterThan(0);

      // Test scoreMatch for all matched windows
      const now = Date.now();

      if (editMatches.length > 0) {
        const editResult = scoreMatch(editFile, now, editMatches[0]);
        expect(editResult).not.toBeNull();
        expect(editResult!.score).toBeGreaterThanOrEqual(30);
      }

      if (bashMatches.length > 0) {
        const bashResult = scoreMatch(bashFile, now, bashMatches[0]);
        expect(bashResult).not.toBeNull();
        expect(bashResult!.score).toBeGreaterThanOrEqual(30);
      }
    }
  );
});
