import {
  runExtensionBuild,
  type ExtensionBuildResult,
} from './extensionBuild';

export interface ExtensionDevRebuildRequest {
  extensionId: string;
  extensionPath: string;
}

export interface ExtensionDevRebuildResult {
  success: boolean;
  error?: string;
}

interface ExtensionDevRebuildDeps {
  runBuild?: (extensionPath: string) => Promise<ExtensionBuildResult>;
  broadcastReload: (request: ExtensionDevRebuildRequest) => Promise<void>;
}

function formatBuildFailure(result: ExtensionBuildResult): string {
  const details = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n\n');
  return details ? `Extension build failed:\n${details}` : 'Extension build failed with no output.';
}

/** Build first, then notify renderers only when fresh output exists. */
export async function rebuildExtensionForDev(
  request: ExtensionDevRebuildRequest,
  deps: ExtensionDevRebuildDeps,
): Promise<ExtensionDevRebuildResult> {
  const buildResult = await (deps.runBuild ?? runExtensionBuild)(request.extensionPath);
  if (!buildResult.success) {
    return { success: false, error: formatBuildFailure(buildResult) };
  }

  await deps.broadcastReload(request);
  return { success: true };
}
