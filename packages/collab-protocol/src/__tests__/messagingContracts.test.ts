import { describe, expect, it } from "vitest";

import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_MENTIONED_AGENTS_PER_MESSAGE,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  MAX_MESSAGE_ATTACHMENT_FILE_NAME_LENGTH,
  type MessageAttachment,
  type RichCommentBody,
  MAX_MENTIONED_USERS_PER_MESSAGE,
  MAX_REACTION_EMOJI_PER_MESSAGE,
  MAX_RESOURCE_REFS_PER_MESSAGE,
  MAX_RICH_COMMENT_TEXT_BYTES,
  type ReactionEntry,
  type ResourceRef,
  validateMentionLimits,
  validateReactionEntries,
  validateResourceRef,
  validateResourceRefs,
  validateRichCommentBody,
} from "../comments.js";
import {
  CONVERSATION_HISTORY_PAGE_SIZE,
  MAX_AGENT_MENTION_HOP_DEPTH,
  type ConversationEvent,
  validateAgentMentionHopDepth,
  validateConversationClientMutationIds,
  validateConversationHistoryPage,
} from "../conversation.js";
import type {
  ConversationAppendAckMessage,
  ConversationHistoryResponseMessage,
} from "../conversationRoom.js";
import type {
  PresenceDeltaMessage,
  PresenceHeartbeatMessage,
  PresenceRosterMessage,
  PresenceStatusSetMessage,
} from "../teamInbox.js";
import { COMMENT_BODY_CONTRACT_CORPUS } from "./commentBodyContractCorpus.js";

const actor = {
  kind: "user",
  userId: "user-1",
  onBehalfOfUserId: "user-1",
} as const;

function event(
  index: number,
  overrides: Partial<ConversationEvent> = {}
): ConversationEvent {
  return {
    id: `event-${index}`,
    conversationId: "conversation-1",
    sequence: index,
    clientMutationId: `mutation-${index}`,
    actor,
    operation: "messageCreated",
    createdAt: index,
    serverReceivedAt: index,
    ...overrides,
  };
}

function refs(count: number): ResourceRef[] {
  return Array.from({ length: count }, (_, index) => ({
    orgId: "org-1",
    kind: "document",
    sourceId: `document-${index}`,
  }));
}

function attachment(
  overrides: Partial<MessageAttachment> = {}
): MessageAttachment {
  return {
    assetId: "asset-1",
    fileName: "screenshot.png",
    mimeType: "image/png",
    byteSize: 2048,
    width: 800,
    height: 600,
    ...overrides,
  };
}

describe("Teams messaging protocol validation", () => {
  it("carries team presence over the organization inbox socket with camelCase discriminators", () => {
    const heartbeat: PresenceHeartbeatMessage = {
      type: "presenceHeartbeat",
      status: "online",
      sentAt: 1,
    };
    const statusSet: PresenceStatusSetMessage = {
      type: "presenceStatusSet",
      status: "away",
      sentAt: 2,
    };
    const roster: PresenceRosterMessage = {
      type: "presenceRoster",
      orgId: "org-1",
      members: [
        {
          teamMemberId: "member-1",
          status: "away",
          lastHeartbeatAt: 2,
          updatedAt: 2,
        },
        {
          teamMemberId: "member-2",
          status: "offline",
          updatedAt: 3,
        },
      ],
    };
    const delta: PresenceDeltaMessage = {
      type: "presenceDelta",
      orgId: "org-1",
      member: {
        teamMemberId: "member-1",
        status: "online",
        lastHeartbeatAt: 4,
        updatedAt: 4,
      },
    };

    const wireRoundTrip = JSON.parse(
      JSON.stringify({ heartbeat, statusSet, roster, delta }),
    ) as {
      heartbeat: PresenceHeartbeatMessage;
      statusSet: PresenceStatusSetMessage;
      roster: PresenceRosterMessage;
      delta: PresenceDeltaMessage;
    };

    expect(wireRoundTrip).toMatchObject({
      heartbeat: { type: "presenceHeartbeat", status: "online" },
      statusSet: { type: "presenceStatusSet", status: "away" },
      roster: {
        type: "presenceRoster",
        members: [
          { teamMemberId: "member-1", status: "away" },
          { teamMemberId: "member-2", status: "offline" },
        ],
      },
      delta: {
        type: "presenceDelta",
        member: { teamMemberId: "member-1", status: "online" },
      },
    });
  });

  it("carries canonical delivery hints in append acknowledgements and history", () => {
    const canonical = event(1, {
      deliveryHints: {
        mentionedUserIds: ["user-2"],
        mentionedAgentSessionIds: [],
        assignedUserIds: ["user-3"],
      },
    });
    const append: ConversationAppendAckMessage = {
      type: "conversationAppendAck",
      event: canonical,
      replayed: false,
    };
    const history: ConversationHistoryResponseMessage = {
      type: "conversationHistoryResponse",
      events: [canonical],
    };

    const wireRoundTrip = JSON.parse(JSON.stringify({ append, history })) as {
      append: ConversationAppendAckMessage;
      history: ConversationHistoryResponseMessage;
    };
    expect(wireRoundTrip.append.event.deliveryHints).toEqual(
      canonical.deliveryHints
    );
    expect(wireRoundTrip.history.events[0].deliveryHints).toEqual(
      canonical.deliveryHints
    );
  });

  it.each(COMMENT_BODY_CONTRACT_CORPUS)(
    "matches the shared comment body corpus: $name",
    ({
      body,
      resourceRefs,
      deliveryHints,
      expectedValid,
      expectedErrorCodes,
      expectedPlainText,
    }) => {
      const result = validateRichCommentBody(body, {
        resourceRefs,
        deliveryHints,
      });

      expect(result.valid).toBe(expectedValid);
      expect(result.errors.map((error) => error.code)).toEqual(
        expectedErrorCodes
      );

      // The renderer asserts what each case renders to; the protocol asserts
      // the one rendering rule it owns — `plainText` means no inline
      // interpretation at all, so the rendered text is the stored text.
      if (body.format === "plainText") {
        expect(expectedPlainText).toBe(body.text);
      }
    }
  );

  it("accepts a rich body at 32 KiB and rejects one encoded byte more", () => {
    const body = {
      version: 1,
      format: "plainText",
      text: "a".repeat(MAX_RICH_COMMENT_TEXT_BYTES),
    } as const;

    expect(new TextEncoder().encode(body.text)).toHaveLength(
      MAX_RICH_COMMENT_TEXT_BYTES
    );
    expect(validateRichCommentBody(body)).toEqual({ valid: true, errors: [] });

    const over = { ...body, text: `${body.text}a` };
    expect(new TextEncoder().encode(over.text)).toHaveLength(
      MAX_RICH_COMMENT_TEXT_BYTES + 1
    );
    expect(validateRichCommentBody(over)).toMatchObject({
      valid: false,
      errors: [
        {
          code: "richBodyTooLarge",
          limit: MAX_RICH_COMMENT_TEXT_BYTES,
          actual: MAX_RICH_COMMENT_TEXT_BYTES + 1,
        },
      ],
    });
  });

  it("rejects a rich body that cannot be encoded as JSON", () => {
    const cyclic: Record<string, unknown> = {
      version: 1,
      format: "plainText",
      text: "",
    };
    cyclic.cyclic = cyclic;

    expect(
      validateRichCommentBody(
        cyclic as {
          version: 1;
          format: "plainText";
          text: string;
        }
      )
    ).toMatchObject({
      valid: false,
      errors: [{ code: "richBodyNotSerializable", path: "body" }],
    });
  });

  it("accepts 16 resource refs and rejects 17", () => {
    expect(validateResourceRefs(refs(MAX_RESOURCE_REFS_PER_MESSAGE))).toEqual({
      valid: true,
      errors: [],
    });
    expect(
      validateResourceRefs(refs(MAX_RESOURCE_REFS_PER_MESSAGE + 1))
    ).toMatchObject({
      valid: false,
      errors: [
        {
          code: "tooManyResourceRefs",
          limit: MAX_RESOURCE_REFS_PER_MESSAGE,
          actual: MAX_RESOURCE_REFS_PER_MESSAGE + 1,
        },
      ],
    });
  });

  it.each([
    ["tracker", false],
    ["document", false],
    ["session", false],
    ["file", true],
    ["commit", true],
    ["pullRequest", true],
    ["conversation", false],
  ] as const)(
    "enforces projectId for the %s resource kind",
    (kind, projectIdRequired) => {
      const ref: ResourceRef = {
        orgId: "org-1",
        kind,
        sourceId: "source-1",
      };

      expect(validateResourceRef(ref).valid).toBe(!projectIdRequired);
      expect(validateResourceRef({ ...ref, projectId: "project-1" })).toEqual({
        valid: true,
        errors: [],
      });
    }
  );

  it("allows messageId only on conversation resource refs", () => {
    expect(
      validateResourceRef({
        orgId: "org-1",
        kind: "conversation",
        sourceId: "conversation-1",
        messageId: "message-1",
      })
    ).toEqual({ valid: true, errors: [] });
    expect(
      validateResourceRef({
        orgId: "org-1",
        kind: "document",
        sourceId: "document-1",
        messageId: "message-1",
      })
    ).toMatchObject({
      valid: false,
      errors: [{ code: "resourceRefMessageIdNotAllowed" }],
    });
  });

  it("accepts 50 distinct mentioned users and rejects 51", () => {
    const users = Array.from(
      { length: MAX_MENTIONED_USERS_PER_MESSAGE },
      (_, index) => `user-${index}`
    );

    expect(validateMentionLimits(users, [])).toEqual({
      valid: true,
      errors: [],
    });
    expect(validateMentionLimits([...users, "user-over"], [])).toMatchObject({
      valid: false,
      errors: [
        {
          code: "tooManyMentionedUsers",
          limit: MAX_MENTIONED_USERS_PER_MESSAGE,
          actual: MAX_MENTIONED_USERS_PER_MESSAGE + 1,
        },
      ],
    });
  });

  it("accepts 8 distinct mentioned agents and rejects 9", () => {
    const agents = Array.from(
      { length: MAX_MENTIONED_AGENTS_PER_MESSAGE },
      (_, index) => `session-${index}`
    );

    expect(validateMentionLimits([], agents)).toEqual({
      valid: true,
      errors: [],
    });
    expect(
      validateMentionLimits([], [...agents, "session-over"])
    ).toMatchObject({
      valid: false,
      errors: [
        {
          code: "tooManyMentionedAgents",
          limit: MAX_MENTIONED_AGENTS_PER_MESSAGE,
          actual: MAX_MENTIONED_AGENTS_PER_MESSAGE + 1,
        },
      ],
    });
  });

  it("counts distinct mention targets rather than repeated IDs", () => {
    expect(
      validateMentionLimits(
        Array(MAX_MENTIONED_USERS_PER_MESSAGE + 1).fill("user-1"),
        Array(MAX_MENTIONED_AGENTS_PER_MESSAGE + 1).fill("session-1")
      )
    ).toEqual({ valid: true, errors: [] });
  });

  it("accepts 20 distinct reaction emoji and rejects 21", () => {
    const reactions: ReactionEntry[] = Array.from(
      { length: MAX_REACTION_EMOJI_PER_MESSAGE },
      (_, index) => ({
        emoji: `emoji-${index}`,
        userId: `user-${index}`,
      })
    );

    expect(validateReactionEntries(reactions)).toEqual({
      valid: true,
      errors: [],
    });
    expect(
      validateReactionEntries([
        ...reactions,
        { emoji: "emoji-over", userId: "user-over" },
      ])
    ).toMatchObject({
      valid: false,
      errors: [
        {
          code: "tooManyReactionEmoji",
          limit: MAX_REACTION_EMOJI_PER_MESSAGE,
          actual: MAX_REACTION_EMOJI_PER_MESSAGE + 1,
        },
      ],
    });
  });

  it("allows one reaction per user per emoji and rejects a duplicate pair", () => {
    expect(
      validateReactionEntries([
        { emoji: "ack", userId: "user-1" },
        { emoji: "ack", userId: "user-2" },
        { emoji: "done", userId: "user-1" },
      ])
    ).toEqual({ valid: true, errors: [] });
    expect(
      validateReactionEntries([
        { emoji: "ack", userId: "user-1" },
        { emoji: "ack", userId: "user-1" },
      ])
    ).toMatchObject({
      valid: false,
      errors: [{ code: "duplicateReaction", path: "reactions[1]" }],
    });
  });

  it("accepts 100 history events and rejects 101", () => {
    const events = Array.from(
      { length: CONVERSATION_HISTORY_PAGE_SIZE },
      (_, index) => event(index)
    );

    expect(validateConversationHistoryPage(events)).toEqual({
      valid: true,
      errors: [],
    });
    expect(
      validateConversationHistoryPage([
        ...events,
        event(CONVERSATION_HISTORY_PAGE_SIZE),
      ])
    ).toMatchObject({
      valid: false,
      errors: [
        {
          code: "historyPageTooLarge",
          limit: CONVERSATION_HISTORY_PAGE_SIZE,
          actual: CONVERSATION_HISTORY_PAGE_SIZE + 1,
        },
      ],
    });
  });

  it("requires clientMutationId uniqueness within each conversation", () => {
    expect(
      validateConversationClientMutationIds([
        event(1, { clientMutationId: "shared-mutation" }),
        event(2, {
          conversationId: "conversation-2",
          clientMutationId: "shared-mutation",
        }),
      ])
    ).toEqual({ valid: true, errors: [] });
    expect(
      validateConversationClientMutationIds([
        event(1, { clientMutationId: "shared-mutation" }),
        event(2, { clientMutationId: "shared-mutation" }),
      ])
    ).toMatchObject({
      valid: false,
      errors: [
        {
          code: "duplicateClientMutationId",
          path: "events[1].clientMutationId",
        },
      ],
    });
  });

  it("accepts a body carrying an image attachment", () => {
    const body: RichCommentBody = {
      version: 1,
      format: "nimbalystMarkdown",
      text: "here it is",
      attachments: [attachment()],
    };

    expect(validateRichCommentBody(body)).toEqual({ valid: true, errors: [] });
  });

  it("accepts 8 attachments and rejects 9", () => {
    const within = {
      version: 1,
      format: "nimbalystMarkdown",
      text: "",
      attachments: Array.from(
        { length: MAX_ATTACHMENTS_PER_MESSAGE },
        (_, index) => attachment({ assetId: `asset-${index}` })
      ),
    } as const;
    expect(validateRichCommentBody(within)).toEqual({ valid: true, errors: [] });

    const over = {
      ...within,
      attachments: [
        ...within.attachments,
        attachment({ assetId: "asset-extra" }),
      ],
    };
    expect(validateRichCommentBody(over)).toMatchObject({
      valid: false,
      errors: [
        {
          code: "tooManyAttachments",
          path: "body.attachments",
          limit: MAX_ATTACHMENTS_PER_MESSAGE,
          actual: MAX_ATTACHMENTS_PER_MESSAGE + 1,
        },
      ],
    });
  });

  it("accepts an attachment at 10 MiB and rejects one byte more", () => {
    const at: RichCommentBody = {
      version: 1,
      format: "nimbalystMarkdown",
      text: "",
      attachments: [attachment({ byteSize: MAX_MESSAGE_ATTACHMENT_BYTES })],
    };
    expect(validateRichCommentBody(at)).toEqual({ valid: true, errors: [] });

    const over = {
      ...at,
      attachments: [attachment({ byteSize: MAX_MESSAGE_ATTACHMENT_BYTES + 1 })],
    };
    expect(validateRichCommentBody(over)).toMatchObject({
      valid: false,
      errors: [
        {
          code: "attachmentTooLarge",
          path: "body.attachments[0].byteSize",
          limit: MAX_MESSAGE_ATTACHMENT_BYTES,
          actual: MAX_MESSAGE_ATTACHMENT_BYTES + 1,
        },
      ],
    });
  });

  it("rejects the same asset attached twice to one message", () => {
    expect(
      validateRichCommentBody({
        version: 1,
        format: "nimbalystMarkdown",
        text: "",
        attachments: [attachment(), attachment()],
      })
    ).toMatchObject({
      valid: false,
      errors: [
        {
          code: "duplicateAttachmentAssetId",
          path: "body.attachments[1].assetId",
        },
      ],
    });
  });

  it.each([
    ["assetId", { assetId: "" }, "body.attachments[0].assetId"],
    ["fileName", { fileName: "" }, "body.attachments[0].fileName"],
    [
      "an over-long fileName",
      { fileName: "a".repeat(MAX_MESSAGE_ATTACHMENT_FILE_NAME_LENGTH + 1) },
      "body.attachments[0].fileName",
    ],
    ["mimeType", { mimeType: "" }, "body.attachments[0].mimeType"],
    ["byteSize", { byteSize: -1 }, "body.attachments[0].byteSize"],
    ["a fractional byteSize", { byteSize: 1.5 }, "body.attachments[0].byteSize"],
    ["width", { width: 0 }, "body.attachments[0].width"],
    ["height", { height: -4 }, "body.attachments[0].height"],
  ])("rejects an attachment with an invalid %s", (_label, overrides, path) => {
    expect(
      validateRichCommentBody({
        version: 1,
        format: "nimbalystMarkdown",
        text: "",
        attachments: [attachment(overrides as Partial<MessageAttachment>)],
      })
    ).toMatchObject({
      valid: false,
      errors: [{ code: expect.stringMatching(/^attachment/), path }],
    });
  });

  it("accepts an attachment without pixel dimensions", () => {
    const { width: _width, height: _height, ...withoutDimensions } =
      attachment();
    expect(
      validateRichCommentBody({
        version: 1,
        format: "nimbalystMarkdown",
        text: "report.pdf",
        attachments: [{ ...withoutDimensions, mimeType: "application/pdf" }],
      })
    ).toEqual({ valid: true, errors: [] });
  });

  it("round-trips an attachment body through JSON unchanged", () => {
    const body = {
      version: 1,
      format: "nimbalystMarkdown",
      text: "see this",
      attachments: [attachment(), attachment({ assetId: "asset-2" })],
    } as const;

    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
  });

  it("leaves a body without attachments byte-identical on the wire", () => {
    // Old clients and old servers must see exactly what they saw before: the
    // field is absent, not present-and-empty.
    const body = {
      version: 1,
      format: "nimbalystMarkdown",
      text: "no files here",
    } as const;

    expect(JSON.stringify(body)).toBe(
      '{"version":1,"format":"nimbalystMarkdown","text":"no files here"}'
    );
    expect(validateRichCommentBody(body)).toEqual({ valid: true, errors: [] });
  });

  it("accepts attachments alongside inline entities", () => {
    expect(
      validateRichCommentBody(
        {
          version: 1,
          format: "nimbalystMarkdown",
          text: "[Doc](nimbalyst://document/doc-1)",
          entities: [{ start: 0, end: 33, kind: "resource", refIndex: 0 }],
          attachments: [attachment()],
        },
        {
          resourceRefs: [
            { orgId: "org-1", kind: "document", sourceId: "doc-1" },
          ],
        }
      )
    ).toEqual({ valid: true, errors: [] });
  });

  it("accepts agent mention hop depth 4 and rejects 5", () => {
    expect(validateAgentMentionHopDepth(MAX_AGENT_MENTION_HOP_DEPTH)).toEqual({
      valid: true,
      errors: [],
    });
    expect(
      validateAgentMentionHopDepth(MAX_AGENT_MENTION_HOP_DEPTH + 1)
    ).toMatchObject({
      valid: false,
      errors: [
        {
          code: "agentHopDepthExceeded",
          limit: MAX_AGENT_MENTION_HOP_DEPTH,
          actual: MAX_AGENT_MENTION_HOP_DEPTH + 1,
        },
      ],
    });
  });
});
