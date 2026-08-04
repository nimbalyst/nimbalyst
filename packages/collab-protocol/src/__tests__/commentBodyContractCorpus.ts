import {
  MAX_RICH_COMMENT_BODY_ENVELOPE_BYTES,
  MAX_RICH_COMMENT_TEXT_BYTES,
  type CommentDeliveryHints,
  type MessagingValidationErrorCode,
  type ResourceRef,
  type RichCommentBody,
} from "../comments.js";

const trackerRef: ResourceRef = {
  orgId: "org-nimbalyst",
  kind: "tracker",
  sourceId: "itm-2212",
};

const noHints: CommentDeliveryHints = {
  mentionedUserIds: [],
  mentionedAgentSessionIds: [],
  assignedUserIds: [],
};

const byteLength = (text: string) =>
  new TextEncoder().encode(text).byteLength;

const userToken = "[@Dana Okafor](nimbalyst://user/user-dana)";
const agentToken =
  "[@Sync repro](nimbalyst://session/session-sync-repro)";
const trackerToken = "[NIM-2212](nimbalyst://tracker/itm-2212)";
const hugeId = "u".repeat(MAX_RICH_COMMENT_BODY_ENVELOPE_BYTES);

export type CommentBodyContractCase = {
  name: string;
  body: RichCommentBody;
  resourceRefs: ResourceRef[];
  deliveryHints: CommentDeliveryHints;
  expectedValid: boolean;
  expectedErrorCodes: MessagingValidationErrorCode[];
  expectedPlainText: string;
};

export const COMMENT_BODY_CONTRACT_CORPUS: CommentBodyContractCase[] = [
  {
    name: "accepts a plain-text body without interpreting inline syntax",
    body: {
      version: 1,
      format: "plainText",
      text: `:rocket: **bold** ${userToken}`,
    },
    resourceRefs: [],
    deliveryHints: {
      ...noHints,
      mentionedUserIds: ["user-dana"],
    },
    expectedValid: true,
    expectedErrorCodes: [],
    expectedPlainText: `:rocket: **bold** ${userToken}`,
  },
  {
    name: "uses the legacy token fallback when entities are absent",
    body: {
      version: 1,
      format: "nimbalystMarkdown",
      text: `${userToken} shipped it`,
    },
    resourceRefs: [],
    deliveryHints: {
      ...noHints,
      mentionedUserIds: ["user-dana"],
    },
    expectedValid: true,
    expectedErrorCodes: [],
    expectedPlainText: "@Dana Okafor shipped it",
  },
  {
    name: "places user, agent, and resource entities by UTF-8 byte offset",
    body: {
      version: 1,
      format: "nimbalystMarkdown",
      text: `Lead ${userToken}; ask ${agentToken}; see ${trackerToken}.`,
      entities: [
        {
          start: byteLength("Lead "),
          end: byteLength(`Lead ${userToken}`),
          kind: "userMention",
          userId: "user-dana",
        },
        {
          start: byteLength(`Lead ${userToken}; ask `),
          end: byteLength(`Lead ${userToken}; ask ${agentToken}`),
          kind: "agentMention",
          sessionId: "session-sync-repro",
        },
        {
          start: byteLength(
            `Lead ${userToken}; ask ${agentToken}; see `,
          ),
          end: byteLength(
            `Lead ${userToken}; ask ${agentToken}; see ${trackerToken}`,
          ),
          kind: "resource",
          refIndex: 0,
        },
      ],
    },
    resourceRefs: [trackerRef],
    deliveryHints: {
      ...noHints,
      mentionedUserIds: ["user-dana"],
      mentionedAgentSessionIds: ["session-sync-repro"],
    },
    expectedValid: true,
    expectedErrorCodes: [],
    expectedPlainText:
      "Lead @Dana Okafor; ask @Sync repro; see itm-2212.",
  },
  {
    name: "entities win when the token grammar names a different mention",
    body: {
      version: 1,
      format: "nimbalystMarkdown",
      text: `${userToken} shipped it`,
      entities: [
        {
          start: 0,
          end: byteLength(userToken),
          kind: "userMention",
          userId: "user-rowan",
        },
      ],
    },
    resourceRefs: [],
    deliveryHints: {
      ...noHints,
      mentionedUserIds: ["user-dana", "user-rowan"],
    },
    expectedValid: true,
    expectedErrorCodes: [],
    expectedPlainText: "@Rowan Petrie shipped it",
  },
  {
    name: "rejects entity offsets outside body text",
    body: {
      version: 1,
      format: "nimbalystMarkdown",
      text: "text",
      entities: [
        {
          start: 0,
          end: 5,
          kind: "userMention",
          userId: "user-dana",
        },
      ],
    },
    resourceRefs: [],
    deliveryHints: {
      ...noHints,
      mentionedUserIds: ["user-dana"],
    },
    expectedValid: false,
    expectedErrorCodes: ["bodyEntityOffsetInvalid"],
    expectedPlainText: "text",
  },
  {
    name: "rejects entity offsets inside a UTF-8 code point",
    body: {
      version: 1,
      format: "nimbalystMarkdown",
      text: "🚀",
      entities: [
        {
          start: 1,
          end: 4,
          kind: "userMention",
          userId: "user-dana",
        },
      ],
    },
    resourceRefs: [],
    deliveryHints: {
      ...noHints,
      mentionedUserIds: ["user-dana"],
    },
    expectedValid: false,
    expectedErrorCodes: ["bodyEntityOffsetInvalid"],
    expectedPlainText: "🚀",
  },
  {
    name: "rejects overlapping entities",
    body: {
      version: 1,
      format: "nimbalystMarkdown",
      text: "abcd",
      entities: [
        {
          start: 0,
          end: 3,
          kind: "userMention",
          userId: "user-dana",
        },
        {
          start: 2,
          end: 4,
          kind: "userMention",
          userId: "user-rowan",
        },
      ],
    },
    resourceRefs: [],
    deliveryHints: {
      ...noHints,
      mentionedUserIds: ["user-dana", "user-rowan"],
    },
    expectedValid: false,
    expectedErrorCodes: ["bodyEntitiesOverlap"],
    expectedPlainText: "abcd",
  },
  {
    name: "rejects out-of-order entities",
    body: {
      version: 1,
      format: "nimbalystMarkdown",
      text: "abcd",
      entities: [
        {
          start: 2,
          end: 4,
          kind: "userMention",
          userId: "user-rowan",
        },
        {
          start: 0,
          end: 2,
          kind: "userMention",
          userId: "user-dana",
        },
      ],
    },
    resourceRefs: [],
    deliveryHints: {
      ...noHints,
      mentionedUserIds: ["user-dana", "user-rowan"],
    },
    expectedValid: false,
    expectedErrorCodes: ["bodyEntitiesOutOfOrder"],
    expectedPlainText: "abcd",
  },
  {
    name: "rejects a resource entity whose refIndex addresses no ref",
    body: {
      version: 1,
      format: "nimbalystMarkdown",
      text: trackerToken,
      entities: [
        {
          start: 0,
          end: byteLength(trackerToken),
          kind: "resource",
          refIndex: 1,
        },
      ],
    },
    resourceRefs: [trackerRef],
    deliveryHints: noHints,
    expectedValid: false,
    expectedErrorCodes: ["bodyEntityResourceRefMissing"],
    expectedPlainText: trackerToken,
  },
  {
    name: "rejects a user entity absent from delivery hints",
    body: {
      version: 1,
      format: "nimbalystMarkdown",
      text: userToken,
      entities: [
        {
          start: 0,
          end: byteLength(userToken),
          kind: "userMention",
          userId: "user-dana",
        },
      ],
    },
    resourceRefs: [],
    deliveryHints: noHints,
    expectedValid: false,
    expectedErrorCodes: ["bodyEntityMentionHintMissing"],
    expectedPlainText: userToken,
  },
  {
    name: "rejects an agent entity absent from delivery hints",
    body: {
      version: 1,
      format: "nimbalystMarkdown",
      text: agentToken,
      entities: [
        {
          start: 0,
          end: byteLength(agentToken),
          kind: "agentMention",
          sessionId: "session-sync-repro",
        },
      ],
    },
    resourceRefs: [],
    deliveryHints: noHints,
    expectedValid: false,
    expectedErrorCodes: ["bodyEntityMentionHintMissing"],
    expectedPlainText: agentToken,
  },
  {
    name: "rejects inline entities on a plain-text body",
    body: {
      version: 1,
      format: "plainText",
      text: "Dana",
      entities: [
        {
          start: 0,
          end: 4,
          kind: "userMention",
          userId: "user-dana",
        },
      ],
    },
    resourceRefs: [],
    deliveryHints: {
      ...noHints,
      mentionedUserIds: ["user-dana"],
    },
    expectedValid: false,
    expectedErrorCodes: ["bodyEntitiesNotAllowedInPlainText"],
    expectedPlainText: "Dana",
  },
  {
    name: "rejects text above the independent 32 KiB UTF-8 bound",
    body: {
      version: 1,
      format: "nimbalystMarkdown",
      text: "a".repeat(MAX_RICH_COMMENT_TEXT_BYTES + 1),
    },
    resourceRefs: [],
    deliveryHints: noHints,
    expectedValid: false,
    expectedErrorCodes: ["richBodyTooLarge"],
    expectedPlainText: "a".repeat(MAX_RICH_COMMENT_TEXT_BYTES + 1),
  },
  {
    name: "rejects an encoded body above the independent 64 KiB envelope bound",
    body: {
      version: 1,
      format: "nimbalystMarkdown",
      text: "x",
      entities: [
        {
          start: 0,
          end: 1,
          kind: "userMention",
          userId: hugeId,
        },
      ],
    },
    resourceRefs: [],
    deliveryHints: {
      ...noHints,
      mentionedUserIds: [hugeId],
    },
    expectedValid: false,
    expectedErrorCodes: ["richBodyEnvelopeTooLarge"],
    expectedPlainText: "x",
  },
];
