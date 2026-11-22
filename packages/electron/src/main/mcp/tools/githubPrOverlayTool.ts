import { getGithubPrOverlayService } from '../../services/GithubPrOverlayService';
import type { McpToolResult } from './trackerToolResult';

interface GithubPrOverlayToolDependencies {
  linkSession(itemId: string): Promise<McpToolResult>;
  notifyAdded(itemId: string): Promise<void>;
  notifyUpdated(itemId: string): Promise<void>;
}

/** The PR URL from a `prUrl` field written as a string or as `{ url, label }`. */
function prUrlOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { url?: unknown }).url === 'string') {
    return (value as { url: string }).url;
  }
  return null;
}

/**
 * Route github-pr tracker_create calls through the URL-keyed overlay service,
 * so an agent's triage item and the panel's review overlay are one row.
 */
export async function handleGithubPrOverlayCreate(
  args: any,
  workspacePath: string,
  shouldLinkSession: boolean,
  dependencies: GithubPrOverlayToolDependencies,
): Promise<McpToolResult | null> {
  if (args.type !== 'github-pr' || !args.fields || typeof args.fields !== 'object') return null;
  const prUrl = prUrlOf(args.fields.prUrl);
  if (!prUrl) return null;

  const updates: Record<string, unknown> = { ...args.fields };
  const status = typeof args.status === 'string' && args.status.trim() ? args.status.trim() : undefined;
  if (status) updates.status = status;
  const result = await getGithubPrOverlayService().getOrCreate({
    workspacePath,
    prUrl,
    title: args.title,
    status,
    customFields: { ...args.fields },
    updates,
  });

  if (shouldLinkSession) {
    const linkResult = await dependencies.linkSession(result.id);
    if (linkResult.isError) return linkResult;
  }
  if (result.created) await dependencies.notifyAdded(result.id);
  else await dependencies.notifyUpdated(result.id);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        structured: {
          action: result.created ? 'created' : 'resolved',
          item: { id: result.id, type: 'github-pr', prUrl: result.prUrl },
        },
        summary: `${result.created ? 'Created' : 'Resolved'} GitHub PR overlay ${result.id} for ${result.prUrl}.`,
      }),
    }],
    isError: false,
  };
}
