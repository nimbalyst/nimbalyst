import { createHash } from 'node:crypto';
import type { TrackerItem } from '@nimbalyst/runtime';
import { globalRegistry } from '@nimbalyst/tracker-schema';
import { getDatabase } from '../database/initialize';
import type { DatabaseEngine } from '../database/PGLiteDatabaseWorker';
import { documentServices } from '../window/WindowManager';
import type { ElectronDocumentService } from './ElectronDocumentService';
import { assertGithubIssueNumber, assertGithubRemote, assertWorkspacePath } from './ghApiHelpers';
import { findGithubOverlayByUrl, type DatabaseLike, type ExistingGithubOverlay } from './githubOverlayLookup';

/**
 * The local overlay for a GitHub pull request: one tracker item per PR per
 * workspace, created when the Pull Requests panel starts a review session so
 * the session stays attached to the PR (NIM-7657). Agent `tracker_create`
 * calls for `github-pr` converge on the same row.
 */

export const GITHUB_PR_OVERLAY_TYPE = 'github-pr';

export interface GithubPrOverlayInput {
  workspacePath: string;
  prUrl: string;
  title: string;
  /** Status for a new overlay; ignored when one already exists (use `updates`). */
  status?: string;
  customFields?: Record<string, unknown>;
  /** Applied to an existing overlay, or merged into a new one. */
  updates?: Record<string, unknown>;
}

export interface GithubPrOverlayResult {
  id: string;
  prUrl: string;
  created: boolean;
}

interface DocumentServiceLike {
  createTrackerItem(
    payload: Parameters<ElectronDocumentService['createTrackerItem']>[0],
  ): Promise<TrackerItem>;
  updateTrackerItem(itemId: string, updates: Record<string, unknown>): Promise<TrackerItem>;
}

interface GithubPrOverlayDependencies {
  db: DatabaseLike;
  engine: DatabaseEngine;
  getDocumentService(workspacePath: string): DocumentServiceLike | undefined;
  /** The workspace model's default status, for a create without one. */
  getDefaultStatus?(workspacePath: string): string | undefined;
}

export function canonicalPrUrl(value: string): { prUrl: string; remote: string; number: number } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid GitHub pull request URL: ${value}`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') {
    throw new Error(`Invalid GitHub pull request URL: ${value}`);
  }
  // Tolerate the PR sub-pages a link may point at (/files, /commits).
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/[^/]*)?\/?$/);
  if (!match) throw new Error(`Invalid GitHub pull request URL: ${value}`);
  const remote = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`.toLowerCase();
  const number = Number(match[3]);
  assertGithubRemote(remote);
  assertGithubIssueNumber(number);
  return { prUrl: `https://github.com/${remote}/pull/${number}`, remote, number };
}

export function githubPrOverlayId(workspacePath: string, prUrl: string): string {
  const key = createHash('sha256')
    .update(workspacePath)
    .update('\0')
    .update(prUrl.toLowerCase())
    .digest('hex')
    .slice(0, 24);
  return `gp_${key}`;
}

function existingUpdates(updates: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!updates) return {};
  const safe = { ...updates };
  // Identity fields are fixed at creation; a triage write must not swap the
  // canonical string for its `{ url, label }` form.
  delete safe.prUrl;
  delete safe.prNumber;
  delete safe.repo;
  return safe;
}

function workspaceDefaultStatus(workspacePath: string): string | undefined {
  const model = globalRegistry.getForWorkspace(workspacePath, GITHUB_PR_OVERLAY_TYPE);
  const field = model?.fields.find((f) => f.name === (model.roles?.workflowStatus ?? 'status'));
  return typeof field?.default === 'string' ? field.default : undefined;
}

export function createGithubPrOverlayService(dependencies: GithubPrOverlayDependencies) {
  const findExisting = (workspacePath: string, prUrl: string): Promise<ExistingGithubOverlay | null> =>
    findGithubOverlayByUrl(
      dependencies.db,
      dependencies.engine,
      workspacePath,
      GITHUB_PR_OVERLAY_TYPE,
      'prUrl',
      prUrl,
    );

  const updateExisting = async (
    documentService: DocumentServiceLike,
    existing: ExistingGithubOverlay,
    updates: Record<string, unknown> | undefined,
  ): Promise<void> => {
    const safeUpdates = existingUpdates(updates);
    if (Object.keys(safeUpdates).length > 0) {
      await documentService.updateTrackerItem(existing.id, safeUpdates);
    }
  };

  return {
    async getOrCreate(input: GithubPrOverlayInput): Promise<GithubPrOverlayResult> {
      assertWorkspacePath(input.workspacePath);
      if (typeof input.title !== 'string' || input.title.trim().length === 0) {
        throw new Error('GitHub PR overlay title required');
      }

      const canonical = canonicalPrUrl(input.prUrl);
      const documentService = dependencies.getDocumentService(input.workspacePath);
      if (!documentService) {
        throw new Error(`Document service unavailable for workspace: ${input.workspacePath}`);
      }

      const existing = await findExisting(input.workspacePath, canonical.prUrl);
      if (existing) {
        await updateExisting(documentService, existing, input.updates);
        return { id: existing.id, prUrl: canonical.prUrl, created: false };
      }

      // The id is a hash of workspace + URL, so two racing creates collide on
      // the primary key and the loser re-finds the winner below.
      const id = githubPrOverlayId(input.workspacePath, canonical.prUrl);
      const status = (typeof input.status === 'string' && input.status.trim())
        || (dependencies.getDefaultStatus ?? workspaceDefaultStatus)(input.workspacePath)
        || 'to-review';
      try {
        const created = await documentService.createTrackerItem({
          id,
          type: GITHUB_PR_OVERLAY_TYPE,
          title: input.title.trim(),
          status: status.trim(),
          priority: '',
          workspace: input.workspacePath,
          customFields: {
            ...input.customFields,
            ...input.updates,
            prUrl: canonical.prUrl,
            prNumber: canonical.number,
            repo: canonical.remote,
          },
          // Fallback only: the workspace's registered model wins
          // (resolveTrackerSharingPolicy), so a team schema shares it.
          sharing: 'personal',
          draftByDefault: false,
        });
        return { id: created.id, prUrl: canonical.prUrl, created: true };
      } catch (error) {
        const raced = await findExisting(input.workspacePath, canonical.prUrl);
        if (!raced) throw error;
        await updateExisting(documentService, raced, input.updates);
        return { id: raced.id, prUrl: canonical.prUrl, created: false };
      }
    },
  };
}

let instance: ReturnType<typeof createGithubPrOverlayService> | null = null;

export function getGithubPrOverlayService() {
  if (!instance) {
    instance = createGithubPrOverlayService({
      db: getDatabase(),
      engine: getDatabase().getEngine(),
      getDocumentService: (workspacePath) => documentServices.get(workspacePath),
    });
  }
  return instance;
}
