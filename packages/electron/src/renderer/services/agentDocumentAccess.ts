/**
 * agentDocumentAccess
 *
 * The one place that answers "how does an agent reach this document?".
 *
 * A target is either a markdown file on disk or a collab:// shared document,
 * and a shared document is reachable either through a mounted editor or
 * headlessly through the room. Before NIM-3754 this decision was made
 * independently in three places -- `useIPCHandlers`' applyDiff and readCollabDoc
 * listeners, and a near-verbatim copy of the applyDiff listener in `aiApi` --
 * and every copy made the same wrong call: refuse unless an editor happens to be
 * mounted. An agent handed a teammate's doc link could not read or edit it until
 * a human opened the tab.
 *
 * Mounted wins when present: it is the state the user is actually looking at,
 * and it avoids putting a second peer in the room. Headless is the fallback,
 * not a degraded path.
 */
import type { TextReplacement } from '@nimbalyst/runtime';
import { editorRegistry } from '@nimbalyst/runtime/ai/EditorRegistry';
import { isCollabUri, parseCollabUri } from '@nimbalyst/collab-protocol';

import {
  acquireHeadlessCollabDocument,
  HeadlessCollabDocumentError,
  readHeadlessCollabDocContent,
} from './HeadlessCollabDocument';
import {
  applyHeadlessCollabDocEdit,
  type CollabDocAgentIdentity,
} from './HeadlessCollabDocEdit';
import {
  hasRecentAgentEditRevision,
  recordRevisionBeforeAgentEdit,
  revisionSourceFromAcquisition,
  revisionSourceFromOpenTab,
} from './collabAgentEditRevision';
import { applyPersonalPageAgentEdit, readPersonalPageForAgent } from './personalAgentEdit';
import { isPersonalPageUri } from '../../shared/personalPageUri';
import { agentPageTitle } from '../utils/agentEditedPage';
import { findOtherProjectDocument } from '../store/atoms/collabDocuments';

export type CollabDocAccessRoute = 'mounted' | 'headless';

export interface CollabDocReadResult {
  content: string;
  route: CollabDocAccessRoute;
}

export interface AgentDiffResult {
  success: boolean;
  error?: string;
  code?: string;
  /** The edited page's title, when it is a page this window can name. */
  title?: string;
}

export interface AgentDiffOptions {
  workspacePath?: string | null;
  /** Surfaced to other collaborators as a participant during a headless edit. */
  agent?: CollabDocAgentIdentity;
  /** Correlates the mounted editor's async completion event with this request. */
  requestId?: string;
}

/**
 * A page that belongs to another project of the workspace's team. The window
 * holds those pages only to name them in links: an edit is refused, and a read
 * goes through the `project` argument like any other cross-project read (main
 * re-routes on this code, with `projectId`).
 */
export class OtherProjectPageError extends Error {
  readonly code = 'OTHER_PROJECT';
  constructor(readonly projectId: string | null, message: string) {
    super(message);
    this.name = 'OtherProjectPageError';
  }
}

/**
 * Throws when `documentUri` names another project's page in the invoking
 * workspace's scope. Checked before the mounted or headless route, since
 * either would reach the page.
 */
export function assertCurrentProjectPage(documentUri: string, workspacePath: string | null | undefined): void {
  if (!workspacePath || !isCollabUri(documentUri)) return;
  let documentId: string;
  try {
    documentId = parseCollabUri(documentUri).documentId;
  } catch {
    return;
  }
  const other = findOtherProjectDocument(workspacePath, documentId);
  if (!other) return;
  const project = other.projectId ?? 'another project';
  throw new OtherProjectPageError(
    other.projectId,
    `"${other.document.title || documentId}" is a page in another project of this team (${project}); changes stay in the current project. Read it with readCollabDoc and project "${project}".`,
  );
}

/**
 * Read a shared document's current content, whether or not it is open.
 *
 * Throws rather than returning empty content when the room cannot be reached --
 * see the header on `HeadlessCollabDocument` for why '' is the dangerous answer.
 */
export async function readCollabDocForAgent(
  documentUri: string,
  workspacePath: string | null | undefined,
): Promise<CollabDocReadResult> {
  if (isPersonalPageUri(documentUri)) {
    return { content: await readPersonalPageForAgent(documentUri, workspacePath), route: 'headless' };
  }
  assertCurrentProjectPage(documentUri, workspacePath);
  if (editorRegistry.has(documentUri)) {
    return { content: editorRegistry.getContent(documentUri), route: 'mounted' };
  }
  if (!workspacePath) {
    throw new HeadlessCollabDocumentError(
      'DOCUMENT_NOT_AVAILABLE',
      `No workspace is available to open the shared document ${documentUri}.`,
    );
  }
  return {
    content: await readHeadlessCollabDocContent(documentUri, workspacePath),
    route: 'headless',
  };
}

/**
 * A mounted shared document takes the agent edit as final text (the editor
 * decides that from its `collab://` path), so record the pre-edit state in its
 * version history first. A tab publishes a history controller; a document open
 * only as an embed is reached through the embed's own cached provider, so this
 * adds no second peer to the room. Never throws.
 */
async function recordRevisionBeforeMountedCollabEdit(
  documentUri: string,
  workspacePath: string | null | undefined,
): Promise<void> {
  if (hasRecentAgentEditRevision(documentUri)) return;
  try {
    const fromTab = revisionSourceFromOpenTab(documentUri);
    if (fromTab) {
      await recordRevisionBeforeAgentEdit(documentUri, fromTab);
      return;
    }
    if (!workspacePath) return;
    const acquisition = await acquireHeadlessCollabDocument(documentUri, workspacePath);
    try {
      const source = revisionSourceFromAcquisition(acquisition);
      if (source) await recordRevisionBeforeAgentEdit(documentUri, source);
    } finally {
      acquisition.release();
    }
  } catch (error) {
    console.warn(
      `[agentDocumentAccess] Could not record the pre-edit revision of ${documentUri}; applying the agent edit anyway.`,
      error,
    );
  }
}

/**
 * Apply an agent's replacements to a markdown file or a shared document.
 *
 * Returns a result rather than throwing, because both callers report the
 * outcome back over an IPC result channel and a thrown error there is just a
 * less specific failure message.
 */
export async function applyAgentDiff(
  targetFilePath: string,
  replacements: TextReplacement[],
  options: AgentDiffOptions = {},
): Promise<AgentDiffResult> {
  const result = await applyAgentDiffToTarget(targetFilePath, replacements, options);
  if (!result.success || !(isCollabUri(targetFilePath) || isPersonalPageUri(targetFilePath))) return result;
  const title = agentPageTitle(targetFilePath, options.workspacePath);
  return title ? { ...result, title } : result;
}

async function applyAgentDiffToTarget(
  targetFilePath: string,
  replacements: TextReplacement[],
  options: AgentDiffOptions,
): Promise<AgentDiffResult> {
  if (isPersonalPageUri(targetFilePath)) {
    return applyPersonalPageAgentEdit(targetFilePath, replacements, {
      workspacePath: options.workspacePath,
      requestId: options.requestId,
    });
  }
  const isCollab = isCollabUri(targetFilePath);
  try {
    assertCurrentProjectPage(targetFilePath, options.workspacePath);
  } catch (error) {
    if (error instanceof OtherProjectPageError) return { success: false, code: error.code, error: error.message };
    throw error;
  }
  if (!isCollab && !targetFilePath.endsWith('.md')) {
    return {
      success: false,
      error: `applyDiff can only modify markdown files (.md) or collaborative documents (collab:// URIs). Attempted to modify: ${targetFilePath}`,
    };
  }

  if (isCollab && !editorRegistry.has(targetFilePath)) {
    if (!options.workspacePath) {
      return {
        success: false,
        code: 'DOCUMENT_NOT_AVAILABLE',
        error: `No workspace is available to open the shared document ${targetFilePath}.`,
      };
    }
    try {
      await applyHeadlessCollabDocEdit(
        targetFilePath,
        options.workspacePath,
        replacements,
        options.agent ? { agent: options.agent } : {},
      );
      return { success: true };
    } catch (error) {
      return {
        success: false,
        ...(error instanceof HeadlessCollabDocumentError
          ? { code: error.code }
          : {}),
        error:
          error instanceof Error
            ? error.message
            : 'Unknown error editing collab document',
      };
    }
  }

  // A markdown file that is not open can simply be opened behind the scenes;
  // a collab document reaching here is already mounted.
  if (!editorRegistry.has(targetFilePath)) {
    const result = await window.electronAPI.readFileContent(targetFilePath);
    await editorRegistry.openFileInBackground(
      targetFilePath,
      result?.success ? result.content : '',
    );
  }

  if (isCollab) {
    await recordRevisionBeforeMountedCollabEdit(targetFilePath, options.workspacePath);
  }

  const result = await editorRegistry.applyReplacements(
    targetFilePath,
    replacements,
    options.requestId,
  );
  return result ?? {
    success: false,
    error: 'No result returned from diff application',
  };
}
