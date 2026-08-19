/**
 * The cross-user `RequestFeedback` tool. Product feedback and GitHub issue
 * reporting remain in the adjacent `feedbackToolHandlers.ts` module.
 */

import {
  STRUCTURED_INPUT_FIELD_TYPES,
  validateFeedbackRequest,
  type FeedbackAsk,
  type FeedbackAskAssignment,
  type FeedbackRequestRecipient,
  type FeedbackRequestVisibility,
  type ResourceRef,
} from '@nimbalyst/collab-protocol';
import {
  loadOrgDirectory,
  readResourceSharingStatus,
  type OrgDirectoryResult,
  type ResourceSharingKind,
  type ResourceSharingResult,
} from './collabReadToolHandlers';

type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
};

type RecipientInput = {
  key: string;
  nameOrEmail: string;
};

type SubjectInput = {
  kind: ResourceSharingKind;
  sourceId: string;
  label?: string;
  context?: string;
  projectId?: string;
};

/**
 * A subject bound to one entry of a select-like ask. Parsed out of the ask and
 * carried alongside it because the org id an artifact's `ResourceRef` needs is
 * not known until the recipient directory has been resolved -- exactly how
 * subjects are already handled.
 */
type AskArtifactInput = SubjectInput & {
  askId: string;
  entryId: string;
};

type AssignmentInput = {
  askId: string;
  recipientKey: string;
};

type RequestFeedbackInput = {
  recipients: RecipientInput[];
  asks: FeedbackAsk[];
  askArtifacts: AskArtifactInput[];
  assignments?: AssignmentInput[];
  subjects: SubjectInput[];
  visibility: FeedbackRequestVisibility;
  quorum: { requiredRecipientCount: number };
  deadline?: number;
};

export type RequestFeedbackOutcome =
  | {
      status: 'draftReady';
      message: string;
      draft: {
        orgId: string;
        recipients: FeedbackRequestRecipient[];
        asks: FeedbackAsk[];
        assignments: FeedbackAskAssignment[];
        subjects: Array<{
          ref: ResourceRef;
          label: string;
          context?: string;
          shared: boolean;
        }>;
        visibility: FeedbackRequestVisibility;
        quorum: { requiredRecipientCount: number };
        quorumMode: 'first' | 'all';
        deadline?: number;
      };
    }
  | {
      status: 'ambiguousRecipient';
      action: 'askWhichRecipient';
      message: string;
      recipientKey: string;
      nameOrEmail: string;
      matches: OrgDirectoryResult['members'];
    }
  | {
      status: 'recipientNotFound';
      message: string;
      recipientKey: string;
      nameOrEmail: string;
    }
  | {
      status: 'noTeam';
      message: string;
    }
  | {
      status: 'subjectNotFound';
      message: string;
      subject: SubjectInput;
    }
  | {
      status: 'invalidDraft';
      message: string;
      errors: Array<{ code: string; message: string }>;
    };

type RequestFeedbackDependencies = {
  findOrgMembers(query: string, workspacePath: string): Promise<OrgDirectoryResult>;
  getResourceSharingStatus(
    kind: ResourceSharingKind,
    sourceId: string,
    workspacePath: string,
  ): Promise<ResourceSharingResult>;
};

const requestFeedbackDependencies: RequestFeedbackDependencies = {
  findOrgMembers: (query, workspacePath) => loadOrgDirectory(workspacePath, query),
  getResourceSharingStatus: (kind, sourceId, workspacePath) =>
    readResourceSharingStatus(kind, sourceId, workspacePath),
};

const STRUCTURED_ASK_SCHEMA = {
  type: 'object',
  description:
    'One typed ask. Required by type: singleSelect uses options; multiSelect and reorder use items; editText uses initialText; confirm has no additional required field; rating uses min and max.',
  properties: {
    type: {
      type: 'string',
      enum: [...STRUCTURED_INPUT_FIELD_TYPES, 'rating'],
    },
    id: { type: 'string', description: 'Stable ask id used by assignments.' },
    label: { type: 'string', description: 'Short label shown above the ask.' },
    description: { type: 'string', description: 'The question or review instruction.' },
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['id', 'label'],
      },
    },
    allowOther: { type: 'boolean' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          subtitle: { type: 'string' },
          badge: { type: 'string' },
          defaultChecked: { type: 'boolean' },
          removable: { type: 'boolean' },
        },
        required: ['id', 'title'],
      },
    },
    minSelected: { type: 'integer', minimum: 0 },
    maxSelected: { type: 'integer', minimum: 0 },
    minItems: { type: 'integer', minimum: 0 },
    initialText: { type: 'string' },
    format: { type: 'string', enum: ['markdown', 'plain'] },
    placeholder: { type: 'string' },
    minLength: { type: 'integer', minimum: 0 },
    maxLength: { type: 'integer', minimum: 1 },
    defaultValue: { type: 'boolean' },
    min: { type: 'number' },
    max: { type: 'number' },
    step: { type: 'number', exclusiveMinimum: 0 },
    initialValue: { type: 'number' },
    minLabel: { type: 'string' },
    maxLabel: { type: 'string' },
    artifacts: {
      type: 'array',
      description:
        'singleSelect and reorder only. Binds a resource to one entry so the recipient sees the artifact itself rather than a label. entryId is an option id or a reorder item id. Sharing is checked and publishing is handled exactly as for subjects; a resource that is also listed in subjects is published once.',
      items: {
        type: 'object',
        properties: {
          entryId: {
            type: 'string',
            description: 'The option id or reorder item id this resource belongs to.',
          },
          kind: { type: 'string', enum: ['document', 'tracker', 'file', 'session'] },
          sourceId: { type: 'string' },
          label: {
            type: 'string',
            description: 'Shown to the recipient. Defaults to sourceId, which reads as an opaque id.',
          },
          context: { type: 'string' },
          projectId: { type: 'string' },
        },
        required: ['entryId', 'kind', 'sourceId'],
      },
    },
  },
  required: ['type', 'id', 'label', 'description'],
};

export const REQUEST_FEEDBACK_TOOL_DESCRIPTION = `Draft a structured, fire-and-forget feedback request for one or more OTHER PEOPLE in the current workspace's organization. Use RequestFeedback when the user wants a named teammate or other org member to answer, including "ask Karl", role-split reviews, team polls, or "get some feedback" when the context means remote teammates.

Do not use AskUserQuestion or PromptForUserInput for a named teammate: those tools ask only the person at this session, block the agent while that local person answers, stay on this machine, and do not deliver through Messaging. Conversely, when an ambiguous instruction such as "get some feedback on these" means ask the person at this session, use AskUserQuestion or PromptForUserInput instead.

RequestFeedback resolves every recipient by name or email with findOrgMembers, checks every subject with getResourceSharingStatus, validates quorum and per-recipient assignments, and returns immediately with a draft for the author to review. It does not publish a subject, create a server request, send a message, wait for a recipient, or silently fall back to asking the local user. The author must approve the compose widget before anything leaves the machine. If a person is ambiguous or absent, surface that outcome and stop. After draftReady, end the turn; replies arrive later through Messaging and wake the session separately.`;

export function getRequestFeedbackToolSchemas() {
  return [
    {
      name: 'RequestFeedback',
      description: REQUEST_FEEDBACK_TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          recipients: {
            type: 'array',
            minItems: 1,
            description:
              'People outside this local session to ask. key is a draft-local assignment handle; nameOrEmail is resolved against the organization directory and is never guessed when ambiguous.',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', description: 'Unique draft-local handle, such as designer or karl.' },
                nameOrEmail: { type: 'string', description: 'Organization member name or email to resolve.' },
              },
              required: ['key', 'nameOrEmail'],
            },
          },
          asks: {
            type: 'array',
            minItems: 1,
            description:
              'Typed questions. Supports singleSelect, multiSelect, reorder, editText, confirm, and rating.',
            items: STRUCTURED_ASK_SCHEMA,
          },
          assignments: {
            type: 'array',
            description:
              'Optional per-recipient split. Omit to assign every ask to every recipient. Each entry maps an askId to one recipients[].key.',
            items: {
              type: 'object',
              properties: {
                askId: { type: 'string' },
                recipientKey: { type: 'string' },
              },
              required: ['askId', 'recipientKey'],
            },
          },
          subjects: {
            type: 'array',
            description:
              'Optional resources being reviewed. Sharing is checked by the tool; never supply or infer a shared flag.',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['document', 'tracker', 'file', 'session'] },
                sourceId: { type: 'string' },
                label: { type: 'string', description: 'Human-readable title shown in the compose widget.' },
                context: { type: 'string', description: 'Optional muted context line, such as a containing folder.' },
                projectId: { type: 'string' },
              },
              required: ['kind', 'sourceId'],
            },
          },
          visibility: {
            type: 'string',
            enum: ['hiddenUntilAnswered', 'open'],
            description: 'Defaults to hiddenUntilAnswered.',
          },
          quorum: {
            type: 'object',
            description:
              'Defaults to all recipients. The compose surface supports first (1) or all (recipient count). Unreachable counts are rejected before review.',
            properties: {
              requiredRecipientCount: { type: 'integer', minimum: 1 },
            },
            required: ['requiredRecipientCount'],
          },
          deadline: {
            type: 'number',
            description: 'Optional deadline as epoch milliseconds.',
          },
        },
        required: ['recipients', 'asks'],
      },
    },
  ];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`RequestFeedback requires ${label} to be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`RequestFeedback requires a non-empty ${label}.`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`RequestFeedback requires ${label} to be a finite number.`);
  }
  return value;
}

function parseOption(value: unknown, label: string) {
  const option = asRecord(value, label);
  return {
    id: requiredString(option.id, `${label}.id`),
    label: requiredString(option.label, `${label}.label`),
    description: optionalString(option.description, `${label}.description`),
  };
}

function parseItem(value: unknown, label: string) {
  const item = asRecord(value, label);
  return {
    id: requiredString(item.id, `${label}.id`),
    title: requiredString(item.title, `${label}.title`),
    subtitle: optionalString(item.subtitle, `${label}.subtitle`),
    badge: optionalString(item.badge, `${label}.badge`),
    defaultChecked: typeof item.defaultChecked === 'boolean' ? item.defaultChecked : undefined,
    removable: typeof item.removable === 'boolean' ? item.removable : undefined,
  };
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`RequestFeedback requires ${label} to be a non-empty array.`);
  }
  return value;
}

function parseSubjectRecord(subject: Record<string, unknown>, label: string): SubjectInput {
  if (!['document', 'tracker', 'file', 'session'].includes(String(subject.kind))) {
    throw new Error(`RequestFeedback ${label}.kind must be document, tracker, file, or session.`);
  }
  return {
    kind: subject.kind as ResourceSharingKind,
    sourceId: requiredString(subject.sourceId, `${label}.sourceId`),
    label: optionalString(subject.label, `${label}.label`),
    context: optionalString(subject.context, `${label}.context`),
    projectId: optionalString(subject.projectId, `${label}.projectId`),
  };
}

/**
 * Artifacts are only accepted on the ask types that can show one. Silently
 * dropping them from a `multiSelect` would leave the caller believing the
 * binding took, and the failure would look identical to no binding at all.
 */
function parseAskArtifacts(
  ask: Record<string, unknown>,
  askId: string,
  label: string,
): AskArtifactInput[] {
  if (ask.artifacts === undefined) return [];
  return requireArray(ask.artifacts, `${label}.artifacts`).map((value, index) => {
    const entry = asRecord(value, `${label}.artifacts[${index}]`);
    return {
      ...parseSubjectRecord(entry, `${label}.artifacts[${index}]`),
      askId,
      entryId: requiredString(entry.entryId, `${label}.artifacts[${index}].entryId`),
    };
  });
}

function parseAsk(
  value: unknown,
  index: number,
  artifacts: AskArtifactInput[],
): FeedbackAsk {
  const label = `asks[${index}]`;
  const ask = asRecord(value, label);
  const type = requiredString(ask.type, `${label}.type`);
  const base = {
    id: requiredString(ask.id, `${label}.id`),
    label: requiredString(ask.label, `${label}.label`),
    description: requiredString(ask.description, `${label}.description`),
  };
  if (ask.artifacts !== undefined && type !== 'singleSelect' && type !== 'reorder') {
    throw new Error(
      `RequestFeedback ${label}.artifacts is only supported on singleSelect and reorder asks.`,
    );
  }

  switch (type) {
    case 'singleSelect':
      artifacts.push(...parseAskArtifacts(ask, base.id, label));
      return {
        ...base,
        type,
        options: requireArray(ask.options, `${label}.options`).map((option, optionIndex) =>
          parseOption(option, `${label}.options[${optionIndex}]`),
        ),
        allowOther: typeof ask.allowOther === 'boolean' ? ask.allowOther : undefined,
      };
    case 'multiSelect':
      return {
        ...base,
        type,
        items: requireArray(ask.items, `${label}.items`).map((item, itemIndex) =>
          parseItem(item, `${label}.items[${itemIndex}]`),
        ),
        minSelected: optionalFiniteNumber(ask.minSelected, `${label}.minSelected`),
        maxSelected: optionalFiniteNumber(ask.maxSelected, `${label}.maxSelected`),
      };
    case 'reorder':
      artifacts.push(...parseAskArtifacts(ask, base.id, label));
      return {
        ...base,
        type,
        items: requireArray(ask.items, `${label}.items`).map((item, itemIndex) =>
          parseItem(item, `${label}.items[${itemIndex}]`),
        ),
        minItems: optionalFiniteNumber(ask.minItems, `${label}.minItems`),
      };
    case 'editText': {
      if (typeof ask.initialText !== 'string') {
        throw new Error(`RequestFeedback requires ${label}.initialText to be a string.`);
      }
      if (ask.format !== undefined && ask.format !== 'markdown' && ask.format !== 'plain') {
        throw new Error(`RequestFeedback ${label}.format must be 'markdown' or 'plain'.`);
      }
      return {
        ...base,
        type,
        initialText: ask.initialText,
        format: ask.format,
        placeholder: optionalString(ask.placeholder, `${label}.placeholder`),
        minLength: optionalFiniteNumber(ask.minLength, `${label}.minLength`),
        maxLength: optionalFiniteNumber(ask.maxLength, `${label}.maxLength`),
      };
    }
    case 'confirm':
      return {
        ...base,
        type,
        defaultValue: typeof ask.defaultValue === 'boolean' ? ask.defaultValue : undefined,
      };
    case 'rating': {
      const min = optionalFiniteNumber(ask.min, `${label}.min`);
      const max = optionalFiniteNumber(ask.max, `${label}.max`);
      if (min === undefined || max === undefined || max <= min) {
        throw new Error(`RequestFeedback ${label} rating requires finite min and max with max greater than min.`);
      }
      return {
        ...base,
        type,
        min,
        max,
        step: optionalFiniteNumber(ask.step, `${label}.step`),
        initialValue: optionalFiniteNumber(ask.initialValue, `${label}.initialValue`),
        minLabel: optionalString(ask.minLabel, `${label}.minLabel`),
        maxLabel: optionalString(ask.maxLabel, `${label}.maxLabel`),
      };
    }
    default:
      throw new Error(
        `RequestFeedback ${label}.type must be singleSelect, multiSelect, reorder, editText, confirm, or rating.`,
      );
  }
}

function parseInput(args: unknown): RequestFeedbackInput {
  const input = asRecord(args, 'arguments');
  const recipientValues = requireArray(input.recipients, 'recipients');
  const recipients = recipientValues.map((value, index) => {
    const recipient = asRecord(value, `recipients[${index}]`);
    return {
      key: requiredString(recipient.key, `recipients[${index}].key`),
      nameOrEmail: requiredString(recipient.nameOrEmail, `recipients[${index}].nameOrEmail`),
    };
  });
  if (new Set(recipients.map((recipient) => recipient.key)).size !== recipients.length) {
    throw new Error('RequestFeedback recipient keys must be unique.');
  }

  const askArtifacts: AskArtifactInput[] = [];
  const asks = requireArray(input.asks, 'asks').map((value, index) =>
    parseAsk(value, index, askArtifacts),
  );
  if (new Set(asks.map((ask) => ask.id)).size !== asks.length) {
    throw new Error('RequestFeedback ask ids must be unique.');
  }

  const assignments = input.assignments === undefined
    ? undefined
    : (Array.isArray(input.assignments) ? input.assignments : (() => {
        throw new Error('RequestFeedback assignments must be an array when provided.');
      })()).map((value, index) => {
        const assignment = asRecord(value, `assignments[${index}]`);
        return {
          askId: requiredString(assignment.askId, `assignments[${index}].askId`),
          recipientKey: requiredString(
            assignment.recipientKey,
            `assignments[${index}].recipientKey`,
          ),
        };
      });

  const subjects = input.subjects === undefined
    ? []
    : (Array.isArray(input.subjects) ? input.subjects : (() => {
        throw new Error('RequestFeedback subjects must be an array when provided.');
      })()).map((value, index) =>
        parseSubjectRecord(asRecord(value, `subjects[${index}]`), `subjects[${index}]`),
      );

  if (input.visibility !== undefined
    && input.visibility !== 'hiddenUntilAnswered'
    && input.visibility !== 'open') {
    throw new Error("RequestFeedback visibility must be 'hiddenUntilAnswered' or 'open'.");
  }

  let requiredRecipientCount = recipients.length;
  if (input.quorum !== undefined) {
    const quorum = asRecord(input.quorum, 'quorum');
    if (!Number.isInteger(quorum.requiredRecipientCount)) {
      throw new Error('RequestFeedback quorum.requiredRecipientCount must be an integer.');
    }
    requiredRecipientCount = quorum.requiredRecipientCount as number;
  }

  return {
    recipients,
    asks,
    askArtifacts,
    assignments,
    subjects,
    visibility: (input.visibility as FeedbackRequestVisibility | undefined) ?? 'hiddenUntilAnswered',
    quorum: { requiredRecipientCount },
    deadline: optionalFiniteNumber(input.deadline, 'deadline'),
  };
}

function subjectRef(subject: SubjectInput, orgId: string, projectId?: string) {
  const resolvedProjectId = projectId ?? subject.projectId;
  return {
    orgId,
    kind: subject.kind,
    sourceId: subject.sourceId,
    ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
  };
}

function outcome(value: RequestFeedbackOutcome, isError = false): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    isError,
  };
}

export async function draftRequestFeedback(
  args: unknown,
  workspacePath: string | undefined,
  dependencies: RequestFeedbackDependencies = requestFeedbackDependencies,
): Promise<RequestFeedbackOutcome> {
  if (!workspacePath?.trim()) {
    throw new Error('RequestFeedback requires an explicit workspacePath.');
  }
  const input = parseInput(args);
  const directoryResults = await Promise.all(
    input.recipients.map((recipient) =>
      dependencies.findOrgMembers(recipient.nameOrEmail, workspacePath),
    ),
  );

  for (let index = 0; index < directoryResults.length; index += 1) {
    const directory = directoryResults[index]!;
    const recipient = input.recipients[index]!;
    if (directory.status === 'noTeam') {
      return { status: 'noTeam', message: directory.message };
    }
    if (directory.status === 'ambiguous') {
      return {
        status: 'ambiguousRecipient',
        action: 'askWhichRecipient',
        message: directory.message,
        recipientKey: recipient.key,
        nameOrEmail: recipient.nameOrEmail,
        matches: directory.members,
      };
    }
    if (directory.status !== 'matched' || directory.members.length !== 1) {
      return {
        status: 'recipientNotFound',
        message: directory.message,
        recipientKey: recipient.key,
        nameOrEmail: recipient.nameOrEmail,
      };
    }
  }

  const org = directoryResults[0]!.org;
  if (!org || directoryResults.some((directory) => directory.org?.orgId !== org.orgId)) {
    return {
      status: 'invalidDraft',
      message: 'All recipients must resolve in the same current organization.',
      errors: [{ code: 'recipientOrgMismatch', message: 'Recipients resolved in different organizations.' }],
    };
  }

  const recipients: FeedbackRequestRecipient[] = directoryResults.map((directory) => ({
    userId: directory.members[0]!.memberId,
    name: directory.members[0]!.displayName,
  }));
  const userIdByRecipientKey = new Map(
    input.recipients.map((recipient, index) => [recipient.key, recipients[index]!.userId]),
  );
  const assignments: FeedbackAskAssignment[] = input.assignments === undefined
    ? recipients.flatMap((recipient) =>
        input.asks.map((ask) => ({
          askId: ask.id,
          target: { kind: 'user' as const, userId: recipient.userId },
        })),
      )
    : input.assignments.map((assignment) => {
        const userId = userIdByRecipientKey.get(assignment.recipientKey);
        if (!userId) {
          throw new Error(
            `RequestFeedback assignment recipientKey '${assignment.recipientKey}' does not name a recipient.`,
          );
        }
        return { askId: assignment.askId, target: { kind: 'user' as const, userId } };
      });

  // Attach bindings before validation. Validating the parsed asks first made
  // unknown and duplicate entry ids invisible to validateFeedbackRequest; the
  // same invalid draft then reached the compose surface and failed only after
  // the author had approved publishing.
  const asks = input.asks.map((ask) => {
    const bound = input.askArtifacts.filter((artifact) => artifact.askId === ask.id);
    if (bound.length === 0) return ask;
    return {
      ...ask,
      artifacts: bound.map((artifact) => ({
        entryId: artifact.entryId,
        ref: subjectRef(artifact, org.orgId, org.teamProjectId),
        label: artifact.label ?? artifact.sourceId,
        ...(artifact.context ? { context: artifact.context } : {}),
      })),
    };
  });

  const validation = validateFeedbackRequest({
    asks,
    recipients,
    assignments,
    quorum: input.quorum,
  });
  if (!validation.valid) {
    return {
      status: 'invalidDraft',
      message: validation.errors.map((error) => error.message).join(' '),
      errors: validation.errors,
    };
  }

  if (input.quorum.requiredRecipientCount !== 1
    && input.quorum.requiredRecipientCount !== recipients.length) {
    return {
      status: 'invalidDraft',
      message: 'The compose surface currently supports quorum from the first reply or from all recipients.',
      errors: [{
        code: 'unsupportedQuorum',
        message: 'requiredRecipientCount must be 1 or the total recipient count.',
      }],
    };
  }

  // An artifact bound to an option is a subject in every way that matters --
  // it has to exist, belong to this org, and be published before a recipient
  // can open it. So the two lists are checked and published as one, deduped by
  // resource: a mockup listed as a subject *and* bound to an option is one
  // thing to share, not two.
  const subjectKey = (subject: SubjectInput) => `${subject.kind}\u0000${subject.sourceId}`;
  const publishable: SubjectInput[] = [];
  const publishableIndex = new Map<string, number>();
  for (const subject of [...input.subjects, ...input.askArtifacts]) {
    const key = subjectKey(subject);
    if (publishableIndex.has(key)) continue;
    publishableIndex.set(key, publishable.length);
    publishable.push(subject);
  }

  const sharingStatuses = await Promise.all(
    publishable.map((subject) =>
      dependencies.getResourceSharingStatus(subject.kind, subject.sourceId, workspacePath),
    ),
  );
  const sharingFor = (subject: SubjectInput) =>
    sharingStatuses[publishableIndex.get(subjectKey(subject))!]!;
  for (let index = 0; index < sharingStatuses.length; index += 1) {
    const sharing = sharingStatuses[index]!;
    const subject = publishable[index]!;
    if (sharing.reason === 'notFound') {
      return {
        status: 'subjectNotFound',
        message: `${subject.kind} subject '${subject.sourceId}' was not found.`,
        subject,
      };
    }
    if (sharing.reason === 'noTeam') {
      return {
        status: 'noTeam',
        message: `The ${subject.kind} subject '${subject.sourceId}' has no current organization.`,
      };
    }
    if (sharing.orgId && sharing.orgId !== org.orgId) {
      return {
        status: 'invalidDraft',
        message: `Subject '${subject.sourceId}' is shared with a different organization.`,
        errors: [{
          code: 'subjectOrgMismatch',
          message: `Subject '${subject.sourceId}' belongs to ${sharing.orgId}, not ${org.orgId}.`,
        }],
      };
    }
  }

  return {
    status: 'draftReady',
    message:
      'Draft ready for author review. Nothing has been published or sent, and this call is not waiting for a recipient.',
    draft: {
      orgId: org.orgId,
      recipients,
      asks,
      assignments,
      subjects: publishable.map((subject) => ({
        ref: subjectRef(subject, sharingFor(subject).orgId ?? org.orgId, org.teamProjectId),
        label: subject.label ?? subject.sourceId,
        ...(subject.context ? { context: subject.context } : {}),
        shared: sharingFor(subject).teamVisible,
      })),
      visibility: input.visibility,
      quorum: input.quorum,
      quorumMode: input.quorum.requiredRecipientCount === 1 ? 'first' : 'all',
      ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
    },
  };
}

export async function handleRequestFeedback(
  args: unknown,
  workspacePath: string | undefined,
  dependencies: RequestFeedbackDependencies = requestFeedbackDependencies,
): Promise<McpToolResult> {
  const drafted = await draftRequestFeedback(args, workspacePath, dependencies);
  return outcome(drafted, drafted.status === 'invalidDraft' || drafted.status === 'subjectNotFound');
}
