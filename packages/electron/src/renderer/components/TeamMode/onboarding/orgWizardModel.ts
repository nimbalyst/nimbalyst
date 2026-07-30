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

export type OrgWizardStepId = 'identity' | 'invite' | 'rooms' | 'done';

export const ORG_WIZARD_STEPS: readonly OrgWizardStepId[] = [
  'identity',
  'invite',
  'rooms',
  'done',
];

export const ORG_WIZARD_STEP_LABELS: Record<OrgWizardStepId, string> = {
  identity: 'Name your org',
  invite: 'Invite your team',
  rooms: 'Starting rooms',
  done: 'Done',
};

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

export interface OrgWizardState {
  step: OrgWizardStepId;
  orgName: string;
  /** Which signed-in personal account owns the new organization. */
  sourcePersonalOrgId: string;
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
  busy: boolean;
  error: string | null;
}

export function createOrgWizardState(
  initial: Partial<Pick<OrgWizardState, 'orgName' | 'sourcePersonalOrgId'>> = {},
): OrgWizardState {
  return {
    step: 'identity',
    orgName: initial.orgName ?? '',
    sourcePersonalOrgId: initial.sourcePersonalOrgId ?? '',
    createdOrgId: null,
    emails: [],
    invitedEmails: [],
    selectedRoomIds: [],
    createdRoomIds: [],
    welcomePosted: false,
    busy: false,
    error: null,
  };
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
