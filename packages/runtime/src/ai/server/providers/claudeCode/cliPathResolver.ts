import {
  resolveClaudeCodeExecutablePath,
  describeMissingClaudeRuntime,
} from '../../../../electron/claudeCodeEnvironment';

/**
 * Resolve the path to the Claude Agent SDK's native binary.
 *
 * SDK 0.2.114+ ships native binaries as per-platform optional dependencies.
 * The SDK resolves these automatically when no pathToClaudeCodeExecutable is set,
 * but in packaged Electron builds require.resolve may not find them inside asar.
 * This function provides a fallback path for packaged builds.
 *
 * NIM-1573: when no bundled binary can be resolved, throw the honest
 * "repair Nimbalyst" message (which names the interrupted-self-update case when
 * detected) rather than a generic error. The run path relies on this so it can
 * fail honestly instead of leaking undefined to the SDK, which then emits a
 * misleading libc/musl ReferenceError.
 */
export async function resolveClaudeAgentCliPath(pathValue?: string): Promise<string> {
  const binaryPath = resolveClaudeCodeExecutablePath({ pathValue, allowSystemFallback: false });
  if (binaryPath) {
    return binaryPath;
  }
  throw new Error(describeMissingClaudeRuntime());
}
