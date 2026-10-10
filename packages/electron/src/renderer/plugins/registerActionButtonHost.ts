/**
 * Desktop host for the action buttons in a page. Both actions go through paths
 * that already exist:
 *
 *   start session   `resolveSession` first settles the model (the user's
 *                   default when the fence names none, checked against
 *                   `aiGetModels`) and clamps the effort for it; the review
 *                   shows that launch and `startSession` runs the same object:
 *                   `createNewSessionActionAtom` (model, and effort in the
 *                   session metadata, as the launch popup does), then the first
 *                   turn the way `dispatchCanvasAgentThread` sends it:
 *                   `ai:sendMessage` with the page as `documentContext.filePath`,
 *                   or the prompt queue for the genuine-CLI provider. The prompt
 *                   ends with a link to the page so the transcript cites it.
 *   new item        Set type's own `createItem` and `setItemPlacement`
 *                   (`buildSetPageTypeDependencies`); an item of a Local wiki
 *                   type goes through the one renderer create call that writes
 *                   it as a file (`createTrackerItem`). Placement is checked
 *                   before `openAgentEditedPage` (`newTab: false`, so a plain
 *                   click replaces this tab), and a failed placement leaves a
 *                   persistent notification saying where the item is.
 *
 * `startSession` is only reached after the user confirmed the prompt in the
 * block; nothing in a request is trusted text (anyone who can edit the page
 * wrote it), so the label is cleaned before it becomes a session title.
 */

import { isCollabUri, parseCollabUri } from '@nimbalyst/collab-protocol';
import { clampEffortLevel } from '@nimbalyst/runtime/ai/server/effortLevels';
import {
  setActionButtonHost,
  type ActionButtonResult,
  type NewItemRequest,
  type ResolveSessionResult,
  type SessionLaunch,
  type StartSessionRequest,
} from '@nimbalyst/runtime/editor/plugins/ActionButtonPlugin/actionButtonHost';
import { countHiddenCharacters } from '@nimbalyst/runtime/editor/plugins/ActionButtonPlugin/hiddenCharacters';
import {
  buildTrackerCreatePayload,
  formatTrackerValidationErrors,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerCreatePayload';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';

import { store } from '../store';
import { createNewSessionActionAtom } from '../store/actions/sessionHistoryActions';
import {
  activeCollabScopeAtom,
  getElectronCollabDocsSession,
  getPersonalCollabDocsSession,
  getPersonalCollabHost,
} from '../store/atoms/collabDocuments';
import { defaultAgentModelAtom, defaultEffortLevelAtom } from '../store/atoms/appSettings';
import { errorNotificationService } from '../services/ErrorNotificationService';
import { createTrackerItem, isLocalWikiType } from '../services/localWikiTrackerRecords';
import { activeWorkspacePathAtom } from '../store/atoms/openProjects';
import { isClaudeCliTerminalSession } from '../components/UnifiedAI/claudeCliInputRouting';
import { buildSetPageTypeDependencies, type SetPageTypeContext } from '../components/CollabMode/useSetPageType';
import { isTeamTrackerSharing } from '../components/Settings/panels/trackerConfigUpgrade';
import { agentPageTitle, openAgentEditedPage } from '../utils/agentEditedPage';
import { personalTypedPageUri } from '../../shared/personalPageUri';

type Section = 'team' | 'personal';

/** The page a button sits on, from the path its editor tab carries. */
export type ButtonPage =
  | { kind: 'page'; section: Section; documentId: string }
  | { kind: 'item'; itemId: string }
  | { kind: 'file'; path: string };

const TRACKER_TAB = 'tracker://';
const TEAM_TYPED_BODY = 'collab://tracker-content/';
const PERSONAL_PREFIXES = ['personal://', 'personal-doc://'];
const MAX_SESSION_TITLE = 80;

/**
 * A Local wiki page opens as a tab on its markdown file, so a file path is
 * first looked up as one; only a path the Local wiki does not know is a file.
 */
export function resolveButtonPage(pagePath: string | null, workspacePath?: string | null): ButtonPage | null {
  if (!pagePath) return null;
  if (pagePath.startsWith(TRACKER_TAB)) return { kind: 'item', itemId: pagePath.slice(TRACKER_TAB.length) };
  if (pagePath.startsWith(TEAM_TYPED_BODY)) return { kind: 'item', itemId: pagePath.slice(TEAM_TYPED_BODY.length) };
  const personal = PERSONAL_PREFIXES.find((prefix) => pagePath.startsWith(prefix));
  if (personal) {
    const rest = pagePath.slice(personal.length);
    if (rest.startsWith('tracker-content/')) return { kind: 'item', itemId: rest.slice('tracker-content/'.length) };
    return rest ? { kind: 'page', section: 'personal', documentId: rest } : null;
  }
  if (isCollabUri(pagePath)) {
    try {
      return { kind: 'page', section: 'team', documentId: parseCollabUri(pagePath).documentId };
    } catch {
      return null;
    }
  }
  if (workspacePath) {
    try {
      const documentId = getPersonalCollabHost(workspacePath).source().documentIdForFile(pagePath);
      if (documentId) return { kind: 'page', section: 'personal', documentId };
    } catch {
      // No Personal pages source yet: the path is treated as a plain file.
    }
  }
  return { kind: 'file', path: pagePath };
}

function typeSection(typeId: string | undefined): Section {
  return isTeamTrackerSharing(globalRegistry.get(typeId ?? '')?.sharing ?? 'personal') ? 'team' : 'personal';
}

function itemSection(itemId: string): Section | null {
  const record = store.get(trackerItemsMapAtom).get(itemId);
  return record ? typeSection(record.primaryType) : null;
}

/** The uri the agent reads the page at (`DocumentContextService` knows these forms). */
function contextUri(page: ButtonPage, pagePath: string): string {
  if (page.kind === 'item') {
    return itemSection(page.itemId) === 'personal' ? personalTypedPageUri(page.itemId) : `${TEAM_TYPED_BODY}${page.itemId}`;
  }
  if (page.kind === 'page' && page.section === 'personal') return `personal://${page.documentId}`;
  return pagePath;
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface AvailableModel {
  id: string;
  name?: string;
}

async function availableModels(): Promise<AvailableModel[]> {
  const response = await window.electronAPI.aiGetModels();
  if (!response?.success) throw new Error('The model list could not be loaded.');
  const all = [...(response.models ?? []), ...Object.values(response.grouped ?? {}).flat()] as AvailableModel[];
  return all.filter((model) => model && typeof model.id === 'string');
}

export async function resolveSessionFromButton(request: StartSessionRequest): Promise<ResolveSessionResult> {
  const hidden = countHiddenCharacters(`${request.label}\n${request.prompt}\n${request.model ?? ''}`);
  if (hidden > 0) return fail(`The button holds ${hidden} hidden characters and cannot be run.`);
  const model = request.model ?? store.get(defaultAgentModelAtom);
  if (!model) return fail('No model is set: name one in the button, or choose a default model in Settings.');
  let match: AvailableModel | undefined;
  try {
    match = (await availableModels()).find((candidate) => candidate.id === model);
  } catch (error) {
    return fail(message(error));
  }
  if (!match) return fail(`Model "${model}" is not available here. Enable its provider, or change the button's model.`);
  const requested = request.effort ?? store.get(defaultEffortLevelAtom);
  const effort = clampEffortLevel(requested, model);
  return {
    ok: true,
    launch: {
      label: request.label,
      prompt: request.prompt,
      model,
      modelName: match.name || model,
      usesDefaultModel: !request.model,
      effort,
      ...(request.effort ? { requestedEffort: request.effort } : {}),
      effortClamped: effort !== requested,
      pagePath: request.pagePath,
    },
  };
}

export async function startSessionFromButton(launch: Readonly<SessionLaunch>): Promise<ActionButtonResult> {
  const workspacePath = store.get(activeWorkspacePathAtom);
  if (!workspacePath) return fail('Open a project to start a session.');
  // The block refuses these before review; a second check costs nothing.
  if (countHiddenCharacters(`${launch.label}\n${launch.prompt}\n${launch.model}`) > 0) return fail('The button holds hidden characters and cannot be run.');

  const page = resolveButtonPage(launch.pagePath, workspacePath);
  const uri = page && launch.pagePath ? contextUri(page, launch.pagePath) : '';
  const name = uri ? agentPageTitle(uri, workspacePath) ?? (page?.kind === 'file' ? uri.split('/').pop() : null) ?? 'this page' : null;
  const title = (launch.label.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim() || 'Page action').slice(0, MAX_SESSION_TITLE);
  const prompt = uri ? `${launch.prompt}\n\n(Started from the "${title}" button on [${name}](${uri}).)` : launch.prompt;

  // Exactly the reviewed model and effort; nothing is re-resolved here.
  const sessionId = await store.set(createNewSessionActionAtom, {
    title,
    selectSession: false,
    model: launch.model,
    metadata: { effortLevel: launch.effort },
  });
  if (!sessionId) return fail('No session could be created.');
  const documentContext = {
    filePath: uri || undefined,
    content: undefined,
    fileType: undefined,
    attachments: undefined,
    mode: 'agent',
    inputType: 'user' as const,
  };
  try {
    const result = (await window.electronAPI.invoke('sessions:get', sessionId)) as { session?: { provider?: string } } | null;
    if (isClaudeCliTerminalSession(result?.session?.provider ?? null)) {
      await window.electronAPI.invoke('ai:createQueuedPrompt', sessionId, prompt, [], documentContext);
    } else {
      const sent = (await window.electronAPI.invoke('ai:sendMessage', prompt, documentContext, sessionId, workspacePath)) as { success?: boolean; error?: string } | undefined;
      if (sent?.success === false) return fail(sent.error || 'The session did not start.');
    }
  } catch (error) {
    return fail(`The session was created but its prompt was not sent: ${message(error)}`);
  }
  window.dispatchEvent(new CustomEvent('open-ai-session', { detail: { sessionId, workspacePath } }));
  return { ok: true };
}

/** Creates the item the way every renderer surface does for this type; resolves its id. */
async function createButtonItem(
  context: SetPageTypeContext,
  request: NewItemRequest,
): Promise<{ itemId: string; error?: string }> {
  if (isLocalWikiType(request.type)) {
    // A wiki type's item is a file in the Local wiki (Decision 9), not a database row.
    const built = buildTrackerCreatePayload(request.type, { title: request.title, content: request.body }, { workspacePath: context.workspacePath });
    if (!built.ok) throw new Error(formatTrackerValidationErrors(built.errors));
    const result = await createTrackerItem(built.payload);
    if (!result.success || !result.item) throw new Error(result.error || 'Could not create the item');
    return { itemId: result.item.id };
  }
  const created = await buildSetPageTypeDependencies(context, request.title)
    .createItem({ typeId: request.type, title: request.title, markdown: request.body });
  return { itemId: created.itemId, ...(created.error ? { error: created.error } : {}) };
}

export async function createItemFromButton(request: NewItemRequest): Promise<ActionButtonResult> {
  const workspacePath = store.get(activeWorkspacePathAtom);
  if (!workspacePath) return fail('Open a project to create pages.');
  const page = resolveButtonPage(request.pagePath, workspacePath);
  if (!page) return fail('This button is not on a page, so there is nowhere to put the new item.');
  if (page.kind === 'file') {
    return fail('This file is not a page in Pages, so a new item cannot be placed under it. Move the button to a team, Personal or Local wiki page.');
  }

  const type = globalRegistry.get(request.type);
  if (!type) return fail(`There is no "${request.type}" page type in this project.`);
  const typeName = type.displayName || request.type;
  const section = typeSection(request.type);
  const parentSection = page.kind === 'page' ? page.section : itemSection(page.itemId);
  if (!parentSection) return fail('This typed page is not loaded here yet; try again in a moment.');
  if (parentSection !== section) {
    return fail(section === 'team'
      ? `"${typeName}" is a team type, so its pages go under team pages.`
      : `"${typeName}" is a personal type, so its pages go under Personal pages.`);
  }

  const teamScope = section === 'team' ? store.get(activeCollabScopeAtom) : null;
  if (section === 'team' && !teamScope) return fail('Open the team project to create team pages.');
  try {
    const session = teamScope ? getElectronCollabDocsSession(teamScope) : getPersonalCollabDocsSession(workspacePath);
    await session.start();
    const context: SetPageTypeContext = {
      lane: section,
      workspacePath,
      session,
      teamScope,
      // Only Set type's tab hand-off reads the strip; creating and placing never do.
      tabsActions: undefined as unknown as SetPageTypeContext['tabsActions'],
    };
    const created = await createButtonItem(context, request);
    const placed = await buildSetPageTypeDependencies(context, request.title).setItemPlacement(
      created.itemId,
      page.kind === 'page' ? page.documentId : page.itemId,
      { parentKind: page.kind, sortOrder: null },
    );
    let failure: string | null = null;
    if (!placed.ok) {
      // The item exists; say so where it outlives this block's error line.
      failure = `"${request.title}" was created, but it could not be placed under this page (${placed.error}). It is listed under ${typeName} in ${section === 'team' ? 'the team' : 'Personal'} Pages.`;
      errorNotificationService.showWarning('New item not placed', failure, { duration: 0 });
    } else if (created.error) {
      failure = `Created "${request.title}", but it has not reached the team yet: ${created.error}`;
    }
    await openAgentEditedPage(`${TRACKER_TAB}${created.itemId}`, workspacePath, {
      source: 'embedded_document',
      options: { newTab: request.newTab },
    });
    return failure ? fail(failure) : { ok: true };
  } catch (error) {
    return fail(message(error));
  }
}

export function registerActionButtonHost(): void {
  setActionButtonHost({ resolveSession: resolveSessionFromButton, startSession: startSessionFromButton, createItem: createItemFromButton });
}
