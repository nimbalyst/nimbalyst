import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentMessagesRepository,
  AISessionsRepository,
  SessionManager,
  TranscriptMigrationRepository,
  type AgentMessagesStore,
  type CreateAgentMessageInput,
  type SessionData,
  type SessionStore,
} from "@nimbalyst/runtime";
import { seedTutorialSessions } from "../TutorialSessionSeeder";

// Resolve from this file, not process.cwd() — the suite runs from both the
// repo root and packages/electron, and a cwd-relative path silently doubles
// the package segment in the latter.
const FIXTURE_DIRECTORY = path.resolve(
  __dirname,
  "../../../../../resources/tutorial-project/sessions"
);
const MATERIALIZED_PATH = path.resolve("/tmp/Nimbalyst Tutorial Materialized");
const SESSION_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];
const EXAMPLE_BUG = {
  key: "EXAMPLE_BUG",
  id: "tk_tutorial_example_bug",
  issueKey: "NIM-6",
  type: "bug" as const,
  title: "Export remains disabled after changing the date range",
};

function createStores() {
  const sessions = new Map<string, SessionData>();
  const sessionPayloads: Array<Parameters<SessionStore["create"]>[0]> = [];
  const messages: CreateAgentMessageInput[] = [];

  const sessionStore: SessionStore = {
    ensureReady: vi.fn(async () => undefined),
    create: vi.fn(async (payload) => {
      sessionPayloads.push(payload);
      sessions.set(payload.id, {
        id: payload.id,
        provider: payload.provider as SessionData["provider"],
        model: payload.model,
        sessionType: payload.sessionType ?? "session",
        mode: payload.mode ?? "agent",
        agentRole: payload.agentRole ?? "standard",
        createdAt: payload.createdAt ?? 0,
        updatedAt: payload.updatedAt ?? 0,
        messages: [],
        workspacePath: payload.workspaceId,
        title: payload.title ?? "New conversation",
        metadata: (payload as { metadata?: Record<string, unknown> }).metadata,
      });
    }),
    updateMetadata: vi.fn(async () => undefined),
    get: vi.fn(async (sessionId) => sessions.get(sessionId) ?? null),
    list: vi.fn(async (workspaceId) =>
      [...sessions.values()]
        .filter((session) => session.workspacePath === workspaceId)
        .map(
          (session) =>
            ({
              id: session.id,
              provider: session.provider,
              model: session.model,
              title: session.title,
              workspacePath: session.workspacePath,
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
            } as never)
        )
    ),
    search: vi.fn(async () => []),
    delete: vi.fn(async (sessionId) => {
      sessions.delete(sessionId);
    }),
  };

  const messagesStore: AgentMessagesStore = {
    create: vi.fn(async (message) => {
      messages.push(message);
    }),
    createMany: vi.fn(async (newMessages) => {
      messages.push(...newMessages);
    }),
    list: vi.fn(async (sessionId) =>
      messages
        .filter((message) => message.sessionId === sessionId)
        .map((message, index) => ({
          ...message,
          id: index + 1,
          createdAt:
            message.createdAt instanceof Date
              ? message.createdAt
              : new Date(message.createdAt ?? 0),
        }))
    ),
  };

  return { sessionStore, messagesStore, sessionPayloads, messages };
}

afterEach(() => {
  AISessionsRepository.clearStore();
  AgentMessagesRepository.clearStore();
  TranscriptMigrationRepository.clearService();
});

describe("seedTutorialSessions", () => {
  it("regenerates ids, rewrites materialized paths, and writes both tracker-link sides", async () => {
    const stores = createStores();
    const linkTrackerSessions = vi.fn(async () => undefined);
    let idIndex = 0;

    const first = await seedTutorialSessions(
      MATERIALIZED_PATH,
      {
        trackerReferences: [EXAMPLE_BUG],
      },
      {
        getSessionStore: () => stores.sessionStore,
        getMessagesStore: () => stores.messagesStore,
        getFixtureDirectory: () => FIXTURE_DIRECTORY,
        generateSessionId: () => SESSION_IDS[idIndex++],
        now: () => 1_800_000_000_000,
        linkTrackerSessions,
      }
    );
    const second = await seedTutorialSessions(
      MATERIALIZED_PATH,
      {
        trackerReferences: [EXAMPLE_BUG],
      },
      {
        getSessionStore: () => stores.sessionStore,
        getMessagesStore: () => stores.messagesStore,
        getFixtureDirectory: () => FIXTURE_DIRECTORY,
        generateSessionId: () => SESSION_IDS[idIndex++],
        now: () => 1_800_000_100_000,
        linkTrackerSessions,
      }
    );

    expect(first.map((session) => session.id)).toEqual(SESSION_IDS.slice(0, 2));
    expect(second.map((session) => session.id)).toEqual(
      SESSION_IDS.slice(2, 4)
    );
    expect(
      new Set([...first, ...second].map((session) => session.id))
    ).toHaveLength(4);
    expect(stores.sessionPayloads).toHaveLength(4);
    expect(stores.sessionPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: MATERIALIZED_PATH,
          metadata: expect.objectContaining({ tutorial: true }),
        }),
      ])
    );

    const serializedMessages = stores.messages.map(
      (message) => message.content
    );
    expect(
      serializedMessages.some((content) =>
        content.includes("{{TUTORIAL_ROOT}}")
      )
    ).toBe(false);
    expect(
      serializedMessages.some((content) => content.includes("{{SESSION_ID:"))
    ).toBe(false);
    expect(
      serializedMessages.some((content) => content.includes("{{TRACKER_"))
    ).toBe(false);
    expect(
      serializedMessages.some((content) =>
        content.includes(path.join(MATERIALIZED_PATH, "product-brief.md"))
      )
    ).toBe(true);
    expect(
      serializedMessages.some((content) => content.includes(SESSION_IDS[0]))
    ).toBe(true);
    expect(
      serializedMessages.filter((content) =>
        content.includes(
          "Note to the user: You can type into the window below and continue this session or start a new one"
        )
      )
    ).toHaveLength(4);

    expect(linkTrackerSessions).toHaveBeenCalledWith(
      MATERIALIZED_PATH,
      EXAMPLE_BUG.id,
      [SESSION_IDS[1]]
    );
    expect(first[1].metadata.linkedTrackerItemIds).toEqual([EXAMPLE_BUG.id]);
  });

  it("loads a seeded session only for its real materialized workspace path", async () => {
    const stores = createStores();
    let idIndex = 0;
    const seeded = await seedTutorialSessions(
      MATERIALIZED_PATH,
      {
        trackerReferences: [EXAMPLE_BUG],
      },
      {
        getSessionStore: () => stores.sessionStore,
        getMessagesStore: () => stores.messagesStore,
        getFixtureDirectory: () => FIXTURE_DIRECTORY,
        generateSessionId: () => SESSION_IDS[idIndex++],
        now: () => 1_800_000_000_000,
        linkTrackerSessions: vi.fn(async () => undefined),
      }
    );
    AgentMessagesRepository.setStore(stores.messagesStore);
    TranscriptMigrationRepository.setService({
      getViewMessages: vi.fn(async () => []),
    } as never);
    const manager = new SessionManager(stores.sessionStore);

    await expect(
      manager.loadSession(seeded[0].id, MATERIALIZED_PATH)
    ).resolves.toMatchObject({
      id: seeded[0].id,
      workspacePath: MATERIALIZED_PATH,
      metadata: expect.objectContaining({ tutorial: true }),
    });
    await expect(
      manager.loadSession(seeded[0].id, path.resolve("/tmp/Other Workspace"))
    ).resolves.toBeNull();
  });
});
