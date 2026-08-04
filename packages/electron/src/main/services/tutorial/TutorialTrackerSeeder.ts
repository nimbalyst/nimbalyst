import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { handleTrackerCreate } from "../../mcp/tools/trackerToolHandlers";
import { ElectronDocumentService } from "../ElectronDocumentService";
import { getTutorialTemplateDirectory } from "./tutorialTemplateDirectory";

export interface TutorialTrackerFixture {
  key: string;
  type: "plan" | "decision" | "bug" | "task";
  title: string;
  status: string;
  priority: "low" | "medium" | "high" | "critical";
  description: string;
  tags: string[];
  fields?: Record<string, unknown>;
}

export interface SeededTutorialTracker {
  key: string;
  id: string;
  issueKey?: string;
  type: TutorialTrackerFixture["type"];
  title: string;
}

export interface TutorialTrackerSeederDependencies {
  getFixturePath: () => string;
  createTrackerItem: (
    workspacePath: string,
    fixture: TutorialTrackerFixture,
    id: string
  ) => Promise<SeededTutorialTracker>;
  deleteTrackerItem: (workspacePath: string, id: string) => Promise<void>;
}

function parseCreatedTracker(
  fixture: TutorialTrackerFixture,
  id: string,
  result: Awaited<ReturnType<typeof handleTrackerCreate>>
): SeededTutorialTracker {
  if (result.isError) {
    const message = result.content.find((entry) => entry.type === "text");
    throw new Error(
      message?.type === "text" && typeof message.text === "string"
        ? message.text
        : `Failed to create ${fixture.key}`
    );
  }

  const text = result.content.find((entry) => entry.type === "text");
  if (!text || text.type !== "text" || typeof text.text !== "string") {
    throw new Error(`Tracker create returned no result for ${fixture.key}`);
  }
  const payload = JSON.parse(text.text) as {
    structured?: { item?: { id?: string; issueKey?: string } };
  };

  return {
    key: fixture.key,
    id: payload.structured?.item?.id ?? id,
    issueKey: payload.structured?.item?.issueKey,
    type: fixture.type,
    title: fixture.title,
  };
}

const defaultDependencies: TutorialTrackerSeederDependencies = {
  getFixturePath: () =>
    path.join(getTutorialTemplateDirectory(), "trackers.json"),
  createTrackerItem: async (workspacePath, fixture, id) => {
    const result = await handleTrackerCreate(
      {
        id,
        type: fixture.type,
        title: fixture.title,
        status: fixture.status,
        priority: fixture.priority,
        description: fixture.description,
        tags: fixture.tags,
        fields: fixture.fields,
        linkSession: false,
      },
      workspacePath
    );
    return parseCreatedTracker(fixture, id, result);
  },
  deleteTrackerItem: async (workspacePath, id) => {
    await new ElectronDocumentService(workspacePath).deleteTrackerItem(id);
  },
};

function trackerId(workspacePath: string, key: string): string {
  const digest = createHash("sha256")
    .update(`${path.resolve(workspacePath)}\0${key}`)
    .digest("hex")
    .slice(0, 24);
  return `tk_tutorial_${digest}`;
}

async function loadFixtures(
  fixturePath: string
): Promise<TutorialTrackerFixture[]> {
  const raw = await fs.readFile(fixturePath, "utf8");
  const fixtures = JSON.parse(raw) as TutorialTrackerFixture[];
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    throw new Error(`Tutorial tracker fixture is empty: ${fixturePath}`);
  }
  return fixtures;
}

export async function seedTutorialTrackers(
  workspacePath: string,
  dependencies: Partial<TutorialTrackerSeederDependencies> = {}
): Promise<SeededTutorialTracker[]> {
  const deps = { ...defaultDependencies, ...dependencies };
  const fixtures = await loadFixtures(deps.getFixturePath());
  const seeded: SeededTutorialTracker[] = [];

  try {
    for (const fixture of fixtures) {
      seeded.push(
        await deps.createTrackerItem(
          workspacePath,
          fixture,
          trackerId(workspacePath, fixture.key)
        )
      );
    }
    return seeded;
  } catch (error) {
    await Promise.allSettled(
      seeded.map((item) => deps.deleteTrackerItem(workspacePath, item.id))
    );
    throw error;
  }
}

export async function deleteTutorialTrackers(
  workspacePath: string,
  items: SeededTutorialTracker[],
  dependencies: Partial<TutorialTrackerSeederDependencies> = {}
): Promise<void> {
  const deps = { ...defaultDependencies, ...dependencies };
  await Promise.allSettled(
    items.map((item) => deps.deleteTrackerItem(workspacePath, item.id))
  );
}
