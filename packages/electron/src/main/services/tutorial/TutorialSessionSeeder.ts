import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import type {
  CreateAgentMessageInput,
  SessionData,
  SessionStore,
} from "@nimbalyst/runtime";
import type { AgentMessagesStore } from "@nimbalyst/runtime/storage/repositories/AgentMessagesRepository";
import { ElectronDocumentService } from "../ElectronDocumentService";
import { getTutorialTemplateDirectory } from "./tutorialTemplateDirectory";
import {
  getBaseAgentMessagesStore,
  getBaseSessionStore,
} from "../RepositoryManager";
import type { SeededTutorialTracker } from "./TutorialTrackerSeeder";

const TUTORIAL_ROOT_PLACEHOLDER = "{{TUTORIAL_ROOT}}";
const SESSION_ID_PLACEHOLDER = /\{\{SESSION_ID:([A-Z0-9_]+)\}\}/g;
const TRACKER_ID_PLACEHOLDER = /\{\{TRACKER_ID:([A-Z0-9_]+)\}\}/g;
const TRACKER_ISSUE_KEY_PLACEHOLDER = /\{\{TRACKER_ISSUE_KEY:([A-Z0-9_]+)\}\}/g;
const KNOWN_TRANSCRIPT_PROVIDERS = new Set([
  "claude-code",
  "codex",
  "codex-acp",
  "copilot",
  "opencode",
  "voice",
]);

export interface TutorialSessionFixture {
  session: {
    provider: string;
    model?: string;
    title: string;
    agentRole?: SessionData["agentRole"];
    metadata?: Record<string, unknown>;
  };
  messages: Array<{
    direction: "input" | "output";
    source: string;
    content: string;
    messageKind: CreateAgentMessageInput["messageKind"];
    hidden: boolean;
  }>;
}

export interface SeededTutorialSession {
  id: string;
  title: string;
  metadata: Record<string, unknown>;
}

export interface TutorialSessionSeedOptions {
  trackerReferences?: SeededTutorialTracker[];
}

export interface TutorialSessionSeederDependencies {
  getSessionStore: () => SessionStore;
  getMessagesStore: () => AgentMessagesStore;
  getFixtureDirectory: (workspacePath: string) => string;
  generateSessionId: () => string;
  now: () => number;
  linkTrackerSessions: (
    workspacePath: string,
    trackerItemId: string,
    sessionIds: string[]
  ) => Promise<void>;
}

function fixtureKey(title: string): string {
  return title
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function validateFixture(
  value: unknown,
  fixturePath: string
): TutorialSessionFixture {
  if (!value || typeof value !== "object") {
    throw new Error(
      `Tutorial session fixture is not an object: ${fixturePath}`
    );
  }

  const fixture = value as Partial<TutorialSessionFixture>;
  const session = fixture.session;
  if (
    !session ||
    typeof session.provider !== "string" ||
    typeof session.title !== "string" ||
    !Array.isArray(fixture.messages)
  ) {
    throw new Error(
      `Tutorial session fixture has an invalid shape: ${fixturePath}`
    );
  }
  if (!KNOWN_TRANSCRIPT_PROVIDERS.has(session.provider)) {
    throw new Error(
      `Tutorial session fixture uses an unsupported provider "${session.provider}": ${fixturePath}`
    );
  }

  for (const [index, message] of fixture.messages.entries()) {
    if (
      !message ||
      (message.direction !== "input" && message.direction !== "output") ||
      typeof message.source !== "string" ||
      typeof message.content !== "string" ||
      typeof message.messageKind !== "string" ||
      typeof message.hidden !== "boolean"
    ) {
      throw new Error(
        `Tutorial session fixture message ${index} has an invalid shape: ${fixturePath}`
      );
    }
  }

  return fixture as TutorialSessionFixture;
}

export async function loadTutorialSessionFixtures(
  fixtureDirectory: string
): Promise<TutorialSessionFixture[]> {
  const entries = (await fs.readdir(fixtureDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name));

  if (entries.length === 0) {
    throw new Error(
      `Tutorial session fixture directory contains no JSON fixtures: ${fixtureDirectory}`
    );
  }

  return Promise.all(
    entries.map(async (entry) => {
      const fixturePath = path.join(fixtureDirectory, entry.name);
      const raw = await fs.readFile(fixturePath, "utf8");
      return validateFixture(JSON.parse(raw), fixturePath);
    })
  );
}

async function linkTrackerSessions(
  workspacePath: string,
  trackerItemId: string,
  sessionIds: string[]
): Promise<void> {
  const documentService = new ElectronDocumentService(workspacePath);
  await documentService.updateTrackerItem(trackerItemId, {
    linkedSessions: sessionIds,
  });
}

const defaultDependencies: TutorialSessionSeederDependencies = {
  getSessionStore: getBaseSessionStore,
  getMessagesStore: getBaseAgentMessagesStore,
  // Read fixtures from the bundled template, NOT the materialized project.
  // The copy step excludes `sessions/` so the user's tutorial folder shows a
  // curated file tree instead of two unexplained raw JSON transcripts.
  getFixtureDirectory: () =>
    path.join(getTutorialTemplateDirectory(), "sessions"),
  generateSessionId: randomUUID,
  now: Date.now,
  linkTrackerSessions,
};

function replaceFixturePlaceholders(
  content: string,
  workspacePath: string,
  sessionIdsByKey: Map<string, string>,
  trackersByKey: Map<string, SeededTutorialTracker>
): string {
  const withRoot = content.split(TUTORIAL_ROOT_PLACEHOLDER).join(workspacePath);
  const withSessions = withRoot.replace(
    SESSION_ID_PLACEHOLDER,
    (_placeholder: string, key: string) => {
      const sessionId = sessionIdsByKey.get(key);
      if (!sessionId) {
        throw new Error(
          `Tutorial session fixture references unknown session key: ${key}`
        );
      }
      return sessionId;
    }
  );
  const withTrackerIds = withSessions.replace(
    TRACKER_ID_PLACEHOLDER,
    (_placeholder: string, key: string) => {
      const tracker = trackersByKey.get(key);
      if (!tracker) {
        throw new Error(
          `Tutorial session fixture references unknown tracker key: ${key}`
        );
      }
      return tracker.id;
    }
  );
  return withTrackerIds.replace(
    TRACKER_ISSUE_KEY_PLACEHOLDER,
    (_placeholder: string, key: string) => {
      const tracker = trackersByKey.get(key);
      if (!tracker) {
        throw new Error(
          `Tutorial session fixture references unknown tracker key: ${key}`
        );
      }
      return tracker.issueKey ?? tracker.id;
    }
  );
}

function replaceMetadataPlaceholders(
  value: unknown,
  workspacePath: string,
  sessionIdsByKey: Map<string, string>,
  trackersByKey: Map<string, SeededTutorialTracker>
): unknown {
  if (typeof value === "string") {
    return replaceFixturePlaceholders(
      value,
      workspacePath,
      sessionIdsByKey,
      trackersByKey
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      replaceMetadataPlaceholders(
        entry,
        workspacePath,
        sessionIdsByKey,
        trackersByKey
      )
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replaceMetadataPlaceholders(
          entry,
          workspacePath,
          sessionIdsByKey,
          trackersByKey
        ),
      ])
    );
  }
  return value;
}

export async function seedTutorialSessions(
  workspacePath: string,
  options: TutorialSessionSeedOptions = {},
  dependencies: Partial<TutorialSessionSeederDependencies> = {}
): Promise<SeededTutorialSession[]> {
  const deps = { ...defaultDependencies, ...dependencies };
  const absoluteWorkspacePath = path.resolve(workspacePath);
  const fixtures = await loadTutorialSessionFixtures(
    deps.getFixtureDirectory(absoluteWorkspacePath)
  );
  const sessionIdsByKey = new Map<string, string>();
  const trackersByKey = new Map(
    (options.trackerReferences ?? []).map((tracker) => [tracker.key, tracker])
  );

  for (const fixture of fixtures) {
    const key = fixtureKey(fixture.session.title);
    if (sessionIdsByKey.has(key)) {
      throw new Error(
        `Duplicate tutorial session fixture title: ${fixture.session.title}`
      );
    }
    sessionIdsByKey.set(key, deps.generateSessionId());
  }

  const sessionStore = deps.getSessionStore();
  const messagesStore = deps.getMessagesStore();
  const seeded: SeededTutorialSession[] = [];
  const createdSessionIds: string[] = [];
  const baseTimestamp = deps.now() - fixtures.length * 60_000;

  try {
    for (const [fixtureIndex, fixture] of fixtures.entries()) {
      const sessionId = sessionIdsByKey.get(fixtureKey(fixture.session.title))!;
      const fixtureMetadata = replaceMetadataPlaceholders(
        fixture.session.metadata ?? {},
        absoluteWorkspacePath,
        sessionIdsByKey,
        trackersByKey
      ) as Record<string, unknown>;
      const metadata = {
        ...fixtureMetadata,
        tutorial: true,
      };
      const createdAt = baseTimestamp + fixtureIndex * 60_000;
      const updatedAt =
        createdAt + Math.max(0, fixture.messages.length - 1) * 1_000;

      await sessionStore.create({
        id: sessionId,
        workspaceId: absoluteWorkspacePath,
        provider: fixture.session.provider,
        model: fixture.session.model,
        title: fixture.session.title,
        sessionType: "session",
        mode: "agent",
        agentRole: fixture.session.agentRole ?? "standard",
        createdAt,
        updatedAt,
        metadata,
        hasBeenNamed: true,
      } as Parameters<SessionStore["create"]>[0]);
      createdSessionIds.push(sessionId);

      const messages: CreateAgentMessageInput[] = fixture.messages.map(
        (message, messageIndex) => ({
          sessionId,
          direction: message.direction,
          source: message.source,
          content: replaceFixturePlaceholders(
            message.content,
            absoluteWorkspacePath,
            sessionIdsByKey,
            trackersByKey
          ),
          messageKind: message.messageKind,
          hidden: message.hidden,
          createdAt: new Date(createdAt + messageIndex * 1_000),
        })
      );

      if (messagesStore.createMany) {
        await messagesStore.createMany(messages);
      } else {
        for (const message of messages) {
          await messagesStore.create(message);
        }
      }

      seeded.push({
        id: sessionId,
        title: fixture.session.title,
        metadata,
      });
    }

    const linkedSessionsByTracker = new Map<string, string[]>();
    for (const session of seeded) {
      const linkedTrackerItemIds = session.metadata.linkedTrackerItemIds;
      if (!Array.isArray(linkedTrackerItemIds)) continue;
      for (const trackerItemId of linkedTrackerItemIds) {
        if (
          typeof trackerItemId !== "string" ||
          trackerItemId.startsWith("file:")
        ) {
          continue;
        }
        const sessionIds = linkedSessionsByTracker.get(trackerItemId) ?? [];
        sessionIds.push(session.id);
        linkedSessionsByTracker.set(trackerItemId, sessionIds);
      }
    }

    for (const [trackerItemId, sessionIds] of linkedSessionsByTracker) {
      await deps.linkTrackerSessions(
        absoluteWorkspacePath,
        trackerItemId,
        sessionIds
      );
    }

    return seeded;
  } catch (error) {
    await Promise.allSettled(
      createdSessionIds.map((sessionId) => sessionStore.delete(sessionId))
    );
    throw error;
  }
}
