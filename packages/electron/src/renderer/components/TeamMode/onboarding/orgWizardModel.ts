/**
 * Pure state for the organization creation wizard.
 *
 * The wizard performs four side effects against three different APIs (create
 * team, invite members, create conversations, post a welcome message), and the
 * user can close the dialog between any of them. Every one of those effects is
 * therefore driven from this module's derived "what is still outstanding"
 * helpers rather than from step transitions: re-running a step after a failure —
 * or after re-opening the wizard on an org that already exists — must not create
 * a second organization, re-send an invite, or duplicate a starter room.
 *
 * Kept free of React and IPC so the state machine and its idempotency guards are
 * testable directly (see `__tests__/orgWizardModel.test.ts`).
 */

import type { CreateConversationInput } from '../../../../shared/conversationDirectory';

export type OrgWizardStepId = 'account' | 'identity' | 'invite' | 'rooms' | 'done';

export const ORG_WIZARD_STEPS: readonly OrgWizardStepId[] = [
  'account',
  'identity',
  'invite',
  'rooms',
  'done',
];

export const ORG_WIZARD_STEP_LABELS: Record<OrgWizardStepId, string> = {
  // One word each: five chips share the dialog's width, and anything longer
  // wraps onto a second line.
  account: 'Account',
  identity: 'Name',
  invite: 'Invite',
  rooms: 'Rooms',
  done: 'Done',
};

export function orgWizardSteps(isAuthenticated: boolean): readonly OrgWizardStepId[] {
  return isAuthenticated ? ORG_WIZARD_STEPS.slice(1) : ORG_WIZARD_STEPS;
}

export interface StarterRoomOption {
  /** Slug the room is addressed by, e.g. `dev` renders as `#dev`. */
  id: string;
  title: string;
  topic: string;
}

/**
 * Offered alongside `#general`, which the server seeds for every org and which
 * the wizard therefore only displays.
 */
export const STARTER_ROOM_OPTIONS: readonly StarterRoomOption[] = [
  { id: 'dev', title: 'dev', topic: 'Engineering work in progress' },
  { id: 'design', title: 'design', topic: 'Design reviews and explorations' },
  { id: 'releases', title: 'releases', topic: 'Ships, changelogs and rollouts' },
];

/** The room every organization already has; shown as included, never created. */
export const GENERAL_ROOM_ID = 'general';

export interface PendingOrgInvitation {
  orgId: string;
  name: string;
  email: string;
}

export interface OrgWizardState {
  step: OrgWizardStepId;
  orgName: string;
  /**
   * Identity the draft belongs to, stamped once the user is authenticated and
   * null while they are not. The draft is stored per machine, so without this a
   * different account signing in on the same machine inherits the previous
   * user's org name, invite list and account choice.
   */
  owner: string | null;
  /** Which signed-in personal account owns the new organization. */
  sourcePersonalOrgId: string;
  /**
   * Project the new organization should adopt on creation. Set when the wizard
   * is opened from a project's Sharing settings, which is the only entry point
   * that has a project in hand; null everywhere else.
   */
  workspacePath: string | null;
  /**
   * Set once the organization exists. Its presence is the create-step
   * idempotency guard: closing the wizard here still leaves a valid org, and
   * re-entering the step must not create a second one.
   */
  createdOrgId: string | null;
  /** Addresses staged as chips on the invite step. */
  emails: string[];
  /** Addresses the invite API has already accepted. */
  invitedEmails: string[];
  selectedRoomIds: string[];
  /** Starter rooms the conversations API has already created. */
  createdRoomIds: string[];
  welcomePosted: boolean;
  pendingInvitation: PendingOrgInvitation | null;
  inviteLookupStatus: 'idle' | 'checking' | 'complete';
  busy: boolean;
  error: string | null;
}

export function createOrgWizardState(
  initial: Partial<
    Pick<OrgWizardState, 'orgName' | 'owner' | 'sourcePersonalOrgId' | 'workspacePath'>
    & { isAuthenticated: boolean }
  > = {},
): OrgWizardState {
  return {
    step: initial.isAuthenticated === false ? 'account' : 'identity',
    orgName: initial.orgName ?? '',
    owner: initial.owner ?? null,
    sourcePersonalOrgId: initial.sourcePersonalOrgId ?? '',
    workspacePath: initial.workspacePath ?? null,
    createdOrgId: null,
    emails: [],
    invitedEmails: [],
    selectedRoomIds: [],
    createdRoomIds: [],
    welcomePosted: false,
    pendingInvitation: null,
    inviteLookupStatus: 'idle',
    busy: false,
    error: null,
  };
}

export function resolveAuthenticatedAccount(
  state: OrgWizardState,
  pendingInvitation: PendingOrgInvitation | null,
): OrgWizardState {
  return {
    ...state,
    step: 'identity',
    pendingInvitation,
    inviteLookupStatus: 'complete',
    error: null,
  };
}

export interface OrgWizardDraft {
  version: 1;
  step: OrgWizardStepId;
  orgName: string;
  /**
   * Absent on drafts written before sign-in, and on drafts written by versions
   * that predate owner scoping — both hydrate for whoever opens the wizard next,
   * because neither can be attributed to a different user.
   */
  owner?: string | null;
  sourcePersonalOrgId: string;
  workspacePath: string | null;
  createdOrgId: string | null;
  emails: string[];
  invitedEmails: string[];
  selectedRoomIds: string[];
  createdRoomIds: string[];
  welcomePosted: boolean;
}

/** Lower-cased so a differently-typed email is still the same identity. */
export function normalizeOwnerId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

/**
 * Whether a stored draft may be handed to the identity currently signed in.
 * An owner-less draft belongs to nobody yet; an owned one belongs to exactly
 * the identity that stamped it.
 */
export function draftOwnerMatches(
  draftOwner: string | null,
  currentOwner: string | null,
): boolean {
  if (draftOwner === null) return true;
  return draftOwner === normalizeOwnerId(currentOwner);
}

export function serializeOrgWizardDraft(state: OrgWizardState): OrgWizardDraft {
  return {
    version: 1,
    step: state.step,
    orgName: state.orgName,
    owner: state.owner,
    sourcePersonalOrgId: state.sourcePersonalOrgId,
    workspacePath: state.workspacePath,
    createdOrgId: state.createdOrgId,
    emails: [...state.emails],
    invitedEmails: [...state.invitedEmails],
    selectedRoomIds: [...state.selectedRoomIds],
    createdRoomIds: [...state.createdRoomIds],
    welcomePosted: state.welcomePosted,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** Steps that only make sense once the organization exists. */
const POST_CREATE_STEPS: readonly OrgWizardStepId[] = ['invite', 'rooms', 'done'];

export function rehydrateOrgWizardDraft(stored: unknown): OrgWizardState | null {
  if (!stored || typeof stored !== 'object') return null;
  const draft = stored as Partial<OrgWizardDraft>;
  if (draft.version !== 1) return null;
  if (!draft.step || !ORG_WIZARD_STEPS.includes(draft.step)) return null;

  const owner = normalizeOwnerId(draft.owner);
  const createdOrgId = typeof draft.createdOrgId === 'string' ? draft.createdOrgId : null;
  // A truncated or hand-edited draft can name a step whose whole screen is about
  // an organization it has no id for. Resume where the wizard can still act:
  // naming it, or signing in first if nobody ever did.
  const step = POST_CREATE_STEPS.includes(draft.step) && !createdOrgId
    ? (owner ? 'identity' : 'account')
    : draft.step;

  return {
    ...createOrgWizardState({ isAuthenticated: step !== 'account' }),
    step,
    owner,
    orgName: typeof draft.orgName === 'string' ? draft.orgName : '',
    sourcePersonalOrgId:
      typeof draft.sourcePersonalOrgId === 'string' ? draft.sourcePersonalOrgId : '',
    workspacePath: typeof draft.workspacePath === 'string' ? draft.workspacePath : null,
    createdOrgId,
    emails: stringArray(draft.emails),
    invitedEmails: stringArray(draft.invitedEmails),
    selectedRoomIds: stringArray(draft.selectedRoomIds),
    createdRoomIds: stringArray(draft.createdRoomIds),
    welcomePosted: draft.welcomePosted === true,
  };
}

// ---------------------------------------------------------------------------
// Owning personal account
// ---------------------------------------------------------------------------

/** The subset of `stytch:get-accounts` rows the wizard's chooser needs. */
export interface OrgWizardPersonalAccount {
  personalOrgId: string;
  email?: string | null;
  isSyncAccount?: boolean;
  sessionStatus?: 'active' | 'expired';
}

/**
 * Which account owns a new organization when the user has not picked one.
 *
 * The sync account is the one the app is actually signed in as everywhere else,
 * so ambient list order is the wrong answer — the retired CreateTeamDialog
 * preferred it, and folding that dialog into the wizard must not lose it. An
 * expired session cannot create anything, so it only wins if nothing else is
 * usable (leaving the picker showing the account the user has to reconnect).
 */
export function defaultSourcePersonalOrgId(
  accounts: readonly OrgWizardPersonalAccount[],
): string {
  const usable = accounts.filter((account) => account.sessionStatus !== 'expired');
  const pool = usable.length > 0 ? usable : accounts;
  return pool.find((account) => account.isSyncAccount)?.personalOrgId
    ?? pool[0]?.personalOrgId
    ?? '';
}

/**
 * Keep a restored draft's account choice only while that account still exists:
 * a signed-out or removed account would otherwise create the org under an id
 * the picker cannot even show.
 */
export function resolveSourcePersonalOrgId(
  current: string,
  accounts: readonly OrgWizardPersonalAccount[],
): string {
  if (accounts.length === 0) return current;
  if (accounts.some((account) => account.personalOrgId === current)) return current;
  return defaultSourcePersonalOrgId(accounts);
}

// ---------------------------------------------------------------------------
// Step machine
// ---------------------------------------------------------------------------

export function stepIndex(step: OrgWizardStepId): number {
  return ORG_WIZARD_STEPS.indexOf(step);
}

export function nextStep(step: OrgWizardStepId): OrgWizardStepId | null {
  return ORG_WIZARD_STEPS[stepIndex(step) + 1] ?? null;
}

export function advance(state: OrgWizardState): OrgWizardState {
  const next = nextStep(state.step);
  if (!next) return state;
  return { ...state, step: next, error: null };
}

export type OrgWizardStepStatus = 'completed' | 'active' | 'upcoming';

export function stepStatus(
  state: OrgWizardState,
  step: OrgWizardStepId,
): OrgWizardStepStatus {
  if (step === state.step) return 'active';
  return stepIndex(step) < stepIndex(state.step) ? 'completed' : 'upcoming';
}

/** Whether the primary action on the current step can run. */
export function canAdvance(state: OrgWizardState): boolean {
  if (state.busy) return false;
  if (state.step === 'account') return false;
  if (state.step === 'identity') return state.orgName.trim().length > 0;
  return state.createdOrgId !== null;
}

/**
 * Steps 2 and 3 are optional; the org already exists by then, so leaving is
 * always safe. Step 1 has nothing to skip and step 4 is the exit.
 */
export function canSkip(state: OrgWizardState): boolean {
  return !state.busy && (state.step === 'invite' || state.step === 'rooms');
}

// ---------------------------------------------------------------------------
// Email entry
// ---------------------------------------------------------------------------

/**
 * Deliberately permissive: Stytch is the authority on deliverability, so this
 * only rejects text that cannot be an address at all (missing local part,
 * missing dotted domain, whitespace).
 */
export function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value.trim());
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export interface ParsedEmailInput {
  emails: string[];
  invalid: string[];
}

/**
 * Split a paste or a typed run of addresses. Commas, semicolons, and any
 * whitespace all separate, so pasting a mail client's "to" line works.
 */
export function parseEmailInput(raw: string): ParsedEmailInput {
  const emails: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const token of raw.split(/[,;\s]+/)) {
    const candidate = token.trim();
    if (!candidate) continue;
    if (!isLikelyEmail(candidate)) {
      invalid.push(candidate);
      continue;
    }
    const normalized = normalizeEmail(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    emails.push(normalized);
  }
  return { emails, invalid };
}

export interface AddEmailsResult {
  state: OrgWizardState;
  invalid: string[];
}

/** Stage addresses as chips, dropping duplicates and already-sent invites. */
export function addEmails(state: OrgWizardState, raw: string): AddEmailsResult {
  const parsed = parseEmailInput(raw);
  const known = new Set([...state.emails, ...state.invitedEmails]);
  const additions = parsed.emails.filter((email) => !known.has(email));
  if (additions.length === 0) {
    return { state, invalid: parsed.invalid };
  }
  return {
    state: { ...state, emails: [...state.emails, ...additions] },
    invalid: parsed.invalid,
  };
}

export function removeEmail(
  state: OrgWizardState,
  email: string,
): OrgWizardState {
  const normalized = normalizeEmail(email);
  return {
    ...state,
    emails: state.emails.filter((entry) => entry !== normalized),
  };
}

/**
 * Addresses still owed an invite. Re-running the step after a partial failure
 * only retries the ones the server never accepted.
 */
export function pendingInvites(state: OrgWizardState): string[] {
  const sent = new Set(state.invitedEmails);
  return state.emails.filter((email) => !sent.has(email));
}

export function markInvited(
  state: OrgWizardState,
  emails: readonly string[],
): OrgWizardState {
  if (emails.length === 0) return state;
  const sent = new Set(state.invitedEmails);
  const additions = emails
    .map(normalizeEmail)
    .filter((email) => !sent.has(email));
  if (additions.length === 0) return state;
  return { ...state, invitedEmails: [...state.invitedEmails, ...additions] };
}

// ---------------------------------------------------------------------------
// Starter rooms
// ---------------------------------------------------------------------------

/** The server's room id shape: `^[A-Za-z0-9._-]+$`. */
export function deriveRoomId(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function toggleStarterRoom(
  state: OrgWizardState,
  roomId: string,
): OrgWizardState {
  const selected = state.selectedRoomIds.includes(roomId);
  return {
    ...state,
    selectedRoomIds: selected
      ? state.selectedRoomIds.filter((entry) => entry !== roomId)
      : [...state.selectedRoomIds, roomId],
  };
}

/**
 * Starter rooms still to create: selected, not created by this wizard run, and
 * not already present in the org's directory (a re-run, or a slug the org
 * happens to already use, must not collide).
 */
export function pendingStarterRooms(
  state: OrgWizardState,
  existingRoomIds: readonly string[] = [],
): StarterRoomOption[] {
  const taken = new Set([
    ...state.createdRoomIds,
    ...existingRoomIds,
    GENERAL_ROOM_ID,
  ]);
  return STARTER_ROOM_OPTIONS.filter(
    (option) => state.selectedRoomIds.includes(option.id) && !taken.has(option.id),
  );
}

export function markRoomsCreated(
  state: OrgWizardState,
  roomIds: readonly string[],
): OrgWizardState {
  if (roomIds.length === 0) return state;
  const known = new Set(state.createdRoomIds);
  const additions = roomIds.filter((roomId) => !known.has(roomId));
  if (additions.length === 0) return state;
  return { ...state, createdRoomIds: [...state.createdRoomIds, ...additions] };
}

export function starterRoomCreateInput(
  option: StarterRoomOption,
): CreateConversationInput {
  return {
    id: option.id,
    kind: 'orgRoom',
    visibility: 'public',
    title: option.title,
    topic: option.topic,
  };
}

// ---------------------------------------------------------------------------
// Identity preview
// ---------------------------------------------------------------------------

/** Up to two letters, taken from the first two words, else the first two characters. */
export function orgAvatarInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Deterministic so the preview in the wizard matches whatever the org shows
 * later, and so tests can assert it without stubbing randomness.
 */
export const ORG_AVATAR_COLORS: readonly string[] = [
  '#6366f1',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#a855f7',
];

export function orgAvatarColor(seed: string): string {
  const normalized = seed.trim().toLowerCase();
  if (!normalized) return ORG_AVATAR_COLORS[0];
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash * 31 + normalized.charCodeAt(index)) % 100000;
  }
  return ORG_AVATAR_COLORS[hash % ORG_AVATAR_COLORS.length];
}

// ---------------------------------------------------------------------------
// Welcome message
// ---------------------------------------------------------------------------

export interface WelcomeMessageBody {
  version: 1;
  format: 'plainText';
  text: string;
}

export function welcomeMessageText(orgName: string): string {
  const name = orgName.trim() || 'this organization';
  return [
    `Welcome to ${name}.`,
    '',
    'This is #general — everyone in the organization is here.',
    'Rooms and direct messages live in the sidebar on the left, the Inbox collects everything addressed to you, and administration sits under Admin at the bottom.',
  ].join('\n');
}

export function welcomeMessageBody(orgName: string): WelcomeMessageBody {
  return { version: 1, format: 'plainText', text: welcomeMessageText(orgName) };
}

/** Posted once per created org; a re-entered wizard must not repeat it. */
export function shouldPostWelcome(state: OrgWizardState): boolean {
  return state.createdOrgId !== null && !state.welcomePosted;
}
