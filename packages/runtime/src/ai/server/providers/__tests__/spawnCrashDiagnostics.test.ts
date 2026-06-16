import { describe, it, expect, afterEach } from 'vitest';
import {
  isBunRuntimeSpawnCrash,
  collectSpawnCrashDiagnostics,
  armAgentSdkDebugLogging,
} from '../claudeCode/spawnCrashDiagnostics';

describe('isBunRuntimeSpawnCrash', () => {
  it('detects the #614 signature: exit code 1 with Bun unknown-error stderr', () => {
    const result = isBunRuntimeSpawnCrash(
      'Claude Code process exited with code 1',
      ['error: An unknown error occurred (Unexpected)\n'],
    );
    expect(result).toBe(true);
  });

  it('detects the low-fd variant of the Bun message', () => {
    const result = isBunRuntimeSpawnCrash(
      'Claude Code process exited with code 1',
      ['error: An unknown error occurred, possibly due to low max file descriptors (Unexpected)\n'],
    );
    expect(result).toBe(true);
  });

  it('detects the signature when stderr was folded into the enriched message', () => {
    const result = isBunRuntimeSpawnCrash(
      'Claude Code process exited with code 1\n\nProcess output:\nerror: An unknown error occurred (Unexpected)',
      [],
    );
    expect(result).toBe(true);
  });

  it('ignores non-exit errors even when stderr mentions unknown errors', () => {
    expect(
      isBunRuntimeSpawnCrash('Stream closed', ['error: An unknown error occurred (Unexpected)']),
    ).toBe(false);
  });

  it('ignores exit-code failures with unrelated stderr (e.g. auth)', () => {
    expect(
      isBunRuntimeSpawnCrash('Claude Code process exited with code 1', ['Not logged in\n']),
    ).toBe(false);
  });
});

describe('collectSpawnCrashDiagnostics', () => {
  it('reports inherited fd limits and binary existence', () => {
    const diag = collectSpawnCrashDiagnostics({ binaryPath: '/nonexistent/claude', cwd: process.cwd() });
    expect(diag.binaryExists).toBe(false);
    expect(diag.cwdExists).toBe(true);
    expect(diag.platform).toBe(process.platform);
    // process.report is available in Node/Electron; userLimits should resolve.
    expect(diag.openFilesLimit ?? diag.userLimits).toBeDefined();
  });
});

describe('armAgentSdkDebugLogging', () => {
  const original = process.env.DEBUG_CLAUDE_AGENT_SDK;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.DEBUG_CLAUDE_AGENT_SDK;
    } else {
      process.env.DEBUG_CLAUDE_AGENT_SDK = original;
    }
  });

  it('arms once and reports already-armed on subsequent calls', () => {
    delete process.env.DEBUG_CLAUDE_AGENT_SDK;
    expect(armAgentSdkDebugLogging()).toBe(true);
    expect(process.env.DEBUG_CLAUDE_AGENT_SDK).toBe('1');
    expect(armAgentSdkDebugLogging()).toBe(false);
  });
});
