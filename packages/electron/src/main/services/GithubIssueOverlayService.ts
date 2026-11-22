import { createHash } from 'node:crypto';
import type { TrackerItem } from '@nimbalyst/runtime';
import { getDatabase } from '../database/initialize';
import type { DatabaseEngine } from '../database/PGLiteDatabaseWorker';
import { documentServices } from '../window/WindowManager';
import type { ElectronDocumentService } from './ElectronDocumentService';
import { assertGithubIssueNumber, assertGithubRemote, assertWorkspacePath } from './ghApiHelpers';
import { findGithubOverlayByUrl } from './githubOverlayLookup';

export const GITHUB_ISSUE_OVERLAY_TYPE = 'github-issue';

export interface GithubIssueOverlayInput {
  workspacePath: string;
  issueUrl: string;
  title: string;
  status: string;
  priority: string;
  customFields?: Record<string, unknown>;
  updates?: Record<string, unknown>;
}

export interface GithubIssueOverlayResult {
  id: string;
  issueUrl: string;
  created: boolean;
}

interface DatabaseLike {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

interface DocumentServiceLike {
  createTrackerItem(
    payload: Parameters<ElectronDocumentService['createTrackerItem']>[0],
  ): Promise<TrackerItem>;
  updateTrackerItem(itemId: string, updates: Record<string, unknown>): Promise<TrackerItem>;
}

interface GithubIssueOverlayDependencies {
  db: DatabaseLike;
  /** Which JSON accessor the overlay-url index is declared with; see jsonKeyExpr. */
  engine: DatabaseEngine;
  getDocumentService(workspacePath: string): DocumentServiceLike | undefined;
}

interface ExistingOverlay {
  id: string;
  data: Record<string, unknown>;
}

function canonicalIssueUrl(value: string): { issueUrl: string; remote: string; number: number } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid GitHub issue URL: ${value}`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') {
    throw new Error(`Invalid GitHub issue URL: ${value}`);
  }
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/);
  if (!match) throw new Error(`Invalid GitHub issue URL: ${value}`);
  const remote = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`.toLowerCase();
  const number = Number(match[3]);
  assertGithubRemote(remote);
  assertGithubIssueNumber(number);
  return { issueUrl: `https://github.com/${remote}/issues/${number}`, remote, number };
}

export function githubIssueOverlayId(workspacePath: string, issueUrl: string): string {
  const key = createHash('sha256')
    .update(workspacePath)
    .update('\0')
    .update(issueUrl.toLowerCase())
    .digest('hex')
    .slice(0, 24);
  return `gi_${key}`;
}

function existingUpdates(
  updates: Record<string, unknown> | undefined,
  existing: ExistingOverlay,
): Record<string, unknown> {
  if (!updates) return {};
  const safe = { ...updates };
  delete safe.issueUrl;
  delete safe.issueNumber;
  delete safe.repo;
  delete safe.author;
  if (
    typeof existing.data.adoptedItemId === 'string' &&
    existing.data.adoptedItemId.trim().length > 0
  ) {
    delete safe.status;
  }
  return safe;
}

export function createGithubIssueOverlayService(dependencies: GithubIssueOverlayDependencies) {
  // Every storage shape, so a teammate's synced overlay (fields nested under
  // customFields) is reused instead of duplicated.
  const findExisting = (workspacePath: string, issueUrl: string): Promise<ExistingOverlay | null> =>
    findGithubOverlayByUrl(
      dependencies.db,
      dependencies.engine,
      workspacePath,
      GITHUB_ISSUE_OVERLAY_TYPE,
      'issueUrl',
      issueUrl,
    );

  const updateExisting = async (
    documentService: DocumentServiceLike,
    existing: ExistingOverlay,
    updates: Record<string, unknown> | undefined,
  ): Promise<void> => {
    const safeUpdates = existingUpdates(updates, existing);
    if (Object.keys(safeUpdates).length > 0) {
      await documentService.updateTrackerItem(existing.id, safeUpdates);
    }
  };

  return {
    async getOrCreate(input: GithubIssueOverlayInput): Promise<GithubIssueOverlayResult> {
      assertWorkspacePath(input.workspacePath);
      if (typeof input.title !== 'string' || input.title.trim().length === 0) {
        throw new Error('GitHub issue overlay title required');
      }
      if (typeof input.status !== 'string' || input.status.trim().length === 0) {
        throw new Error('GitHub issue overlay status required');
      }
      if (typeof input.priority !== 'string') {
        throw new Error('GitHub issue overlay priority must be a string');
      }

      const canonical = canonicalIssueUrl(input.issueUrl);
      const documentService = dependencies.getDocumentService(input.workspacePath);
      if (!documentService) {
        throw new Error(`Document service unavailable for workspace: ${input.workspacePath}`);
      }

      const existingId = await findExisting(input.workspacePath, canonical.issueUrl);
      if (existingId) {
        await updateExisting(documentService, existingId, input.updates);
        return { id: existingId.id, issueUrl: canonical.issueUrl, created: false };
      }

      const id = githubIssueOverlayId(input.workspacePath, canonical.issueUrl);
      const customFields = {
        ...input.customFields,
        ...input.updates,
        issueUrl: canonical.issueUrl,
        issueNumber: canonical.number,
        repo: canonical.remote,
      };
      try {
        const created = await documentService.createTrackerItem({
          id,
          type: GITHUB_ISSUE_OVERLAY_TYPE,
          title: input.title.trim(),
          status: input.status.trim(),
          priority: input.priority.trim(),
          workspace: input.workspacePath,
          customFields,
          sharing: 'personal',
          draftByDefault: false,
        });
        return { id: created.id, issueUrl: canonical.issueUrl, created: true };
      } catch (error) {
        const racedId = await findExisting(input.workspacePath, canonical.issueUrl);
        if (!racedId) throw error;
        await updateExisting(documentService, racedId, input.updates);
        return { id: racedId.id, issueUrl: canonical.issueUrl, created: false };
      }
    },
  };
}

let instance: ReturnType<typeof createGithubIssueOverlayService> | null = null;

export function getGithubIssueOverlayService() {
  if (!instance) {
    instance = createGithubIssueOverlayService({
      db: getDatabase(),
      engine: getDatabase().getEngine(),
      getDocumentService: (workspacePath) => documentServices.get(workspacePath),
    });
  }
  return instance;
}
