/**
 * The `memory` tracker type schema.
 *
 * This file DEFINES the type. It does not create it. Creating it is a single
 * `tracker_define_type` call with `schema` set to this object, and that call is
 * the user's to make: a tracker type appears in their UI and can be shared to
 * their org, so it is not something an implementation phase gets to do as a
 * side effect. `memory-tracker-type.json` at the extension root is this object
 * serialised, ready to hand to the tool verbatim; a test pins the two together
 * so the artifact cannot drift from the source.
 *
 * Why a tracker type at all (plan decision 1): scopes, team sync, history,
 * conflict links, provenance, lifecycle and governance already exist and are
 * already tested on this substrate. A bespoke fact store would rebuild every
 * one of them. The fields below are therefore deliberately thin — most of what
 * a memory needs is inherited, and the ones here are what the substrate does
 * not already know how to say.
 *
 * `sharing: personal` is the safe default and matches the plan's class
 * description: mined facts are personal until somebody publishes them.
 */
import { MEMORY_TYPES } from './types.js';

/** Field names the record model reads and writes on a tracker item. */
export const MEMORY_FIELD_NAMES = {
  factId: 'factId',
  type: 'memoryType',
  scope: 'scope',
  status: 'status',
  confidence: 'confidence',
  provenanceKind: 'provenanceKind',
  provenanceSession: 'provenanceSession',
  provenanceSource: 'provenanceSource',
  validFrom: 'validFrom',
  validTo: 'validTo',
  expiresAt: 'expiresAt',
  supersedes: 'supersedes',
  duplicates: 'duplicates',
  redacted: 'redacted',
  /** Volatile — database columns on the item, never in the replica. */
  recallCount: 'recallCount',
  lastRecalledAt: 'lastRecalledAt',
} as const;

const TYPE_OPTIONS = [
  { value: 'decision', label: 'Decision', icon: 'gavel' },
  { value: 'preference', label: 'Preference', icon: 'tune' },
  { value: 'instruction', label: 'Instruction', icon: 'assignment' },
  { value: 'convention', label: 'Convention', icon: 'rule' },
  { value: 'constraint', label: 'Constraint', icon: 'block' },
  { value: 'error', label: 'Error', icon: 'bug_report' },
  { value: 'fact', label: 'Fact', icon: 'info' },
];

// Guards the option list against the type union drifting apart from it.
if (TYPE_OPTIONS.length !== MEMORY_TYPES.length) {
  throw new Error('memory schema: type options and MEMORY_TYPES disagree');
}

export const MEMORY_TRACKER_SCHEMA = {
  type: 'memory',
  displayName: 'Memory',
  displayNamePlural: 'Memories',
  icon: 'neurology',
  color: '#8b5cf6',
  // `fullDocument` is not decoration here. The payload IS the body (decision
  // 7); a memory that can only be seen as an inline row is back to being a
  // one-liner with extra columns.
  modes: { inline: true, fullDocument: true },
  idPrefix: 'mem',
  idFormat: 'ulid',
  fields: [
    { name: 'title', type: 'string', required: true, displayInline: true },
    {
      name: MEMORY_FIELD_NAMES.factId,
      type: 'string',
      required: true,
      displayInline: false,
      readOnly: true,
      description:
        'Content-derived stable id and the replica sort key. Not the tracker item id.',
    },
    {
      name: MEMORY_FIELD_NAMES.type,
      type: 'select',
      required: true,
      default: 'fact',
      displayInline: true,
      options: TYPE_OPTIONS,
      description: 'A facet over the page, not a replacement for it.',
    },
    {
      name: MEMORY_FIELD_NAMES.scope,
      type: 'select',
      required: true,
      default: 'personal',
      displayInline: true,
      options: [
        { value: 'personal', label: 'Personal', icon: 'person' },
        { value: 'project', label: 'Project', icon: 'folder' },
        { value: 'team', label: 'Team', icon: 'group' },
      ],
      description: 'Personal never reaches a shared repo or a team room.',
    },
    {
      name: MEMORY_FIELD_NAMES.status,
      type: 'select',
      required: true,
      default: 'candidate',
      displayInline: true,
      options: [
        { value: 'candidate', label: 'Candidate', icon: 'inbox', category: 'backlog' },
        { value: 'active', label: 'Active', icon: 'check_circle', category: 'started' },
        { value: 'superseded', label: 'Superseded', icon: 'history', category: 'done' },
        { value: 'archived', label: 'Archived', icon: 'archive', category: 'cancelled' },
      ],
    },
    {
      name: MEMORY_FIELD_NAMES.confidence,
      type: 'number',
      required: false,
      default: 0.5,
      displayInline: true,
      description: '0-1. Distilled pages start below user-authored ones.',
    },
    {
      name: MEMORY_FIELD_NAMES.provenanceKind,
      type: 'select',
      required: true,
      default: 'user',
      displayInline: true,
      options: [
        { value: 'user', label: 'User' },
        { value: 'distilled', label: 'Distilled' },
        { value: 'promoted', label: 'Promoted' },
        { value: 'imported', label: 'Imported' },
      ],
      description:
        'Team memory is ungoverned for the beta, so provenance display is the ' +
        'only detection mechanism for a bad shared page. Not decorative.',
    },
    {
      name: MEMORY_FIELD_NAMES.provenanceSession,
      type: 'string',
      required: false,
      displayInline: false,
      description: 'Session that produced the page, clickable through in the browser.',
    },
    {
      name: MEMORY_FIELD_NAMES.provenanceSource,
      type: 'string',
      required: false,
      displayInline: false,
    },
    {
      name: MEMORY_FIELD_NAMES.validFrom,
      type: 'datetime',
      required: false,
      displayInline: false,
      description: 'When the claim started being true, not when it was written.',
    },
    {
      name: MEMORY_FIELD_NAMES.validTo,
      type: 'datetime',
      required: false,
      displayInline: false,
      description: 'Set once on supersede. Superseding narrows a window; it never erases.',
    },
    {
      name: MEMORY_FIELD_NAMES.expiresAt,
      type: 'datetime',
      required: false,
      displayInline: false,
    },
    {
      name: MEMORY_FIELD_NAMES.supersedes,
      type: 'relationship',
      required: false,
      displayInline: false,
      relationshipTypeKey: 'supersedes',
      inverseRelationshipTypeKey: 'superseded-by',
      inverseFieldId: 'supersededBy',
      targetTrackerTypes: ['memory'],
      multiValue: true,
      description: 'Explicit retirement. Beats the validity window at read time.',
    },
    {
      name: 'supersededBy',
      type: 'relationship',
      required: false,
      displayInline: true,
      relationshipTypeKey: 'superseded-by',
      inverseRelationshipTypeKey: 'supersedes',
      inverseFieldId: MEMORY_FIELD_NAMES.supersedes,
      targetTrackerTypes: ['memory'],
      multiValue: true,
    },
    {
      name: MEMORY_FIELD_NAMES.duplicates,
      type: 'relationship',
      required: false,
      displayInline: false,
      relationshipTypeKey: 'duplicates',
      inverseRelationshipTypeKey: 'duplicates',
      inverseFieldId: MEMORY_FIELD_NAMES.duplicates,
      targetTrackerTypes: ['memory'],
      multiValue: true,
      description: 'Ambiguous overlap awaiting a human decision.',
    },
    {
      name: MEMORY_FIELD_NAMES.redacted,
      type: 'boolean',
      required: false,
      default: false,
      displayInline: false,
      description: 'The write gate rewrote this body before storing it.',
    },
    // Volatile. Present on the item because decay and ranking need them and
    // they are near-free to write; excluded from the replica by construction
    // (see replica.ts), NOT by anyone remembering to skip them here.
    {
      name: MEMORY_FIELD_NAMES.recallCount,
      type: 'number',
      required: false,
      default: 0,
      displayInline: false,
      readOnly: true,
      description: 'Volatile: database-only, never exported to the JSONL replica.',
    },
    {
      name: MEMORY_FIELD_NAMES.lastRecalledAt,
      type: 'datetime',
      required: false,
      displayInline: false,
      readOnly: true,
      description: 'Volatile: database-only, never exported to the JSONL replica.',
    },
    { name: 'tags', type: 'array', itemType: 'string', required: false, displayInline: false },
    { name: 'created', type: 'datetime', required: false, displayInline: false, readOnly: true },
    { name: 'updated', type: 'datetime', required: false, displayInline: false, readOnly: true },
  ],
  statusBarLayout: [
    {
      row: [
        { field: MEMORY_FIELD_NAMES.status, width: 140 },
        { field: MEMORY_FIELD_NAMES.type, width: 140 },
        { field: MEMORY_FIELD_NAMES.scope, width: 120 },
        { field: MEMORY_FIELD_NAMES.provenanceKind, width: 130 },
      ],
    },
  ],
  inlineTemplate: '{icon} {title} {memoryType} {scope}',
  roles: {
    title: 'title',
    workflowStatus: MEMORY_FIELD_NAMES.status,
    tags: 'tags',
  },
  sharing: 'personal',
  draftByDefault: false,
} as const;
