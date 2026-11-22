import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { KeyboardShortcuts } from "../../../../shared/KeyboardShortcuts";

const tutorialRoot = fileURLToPath(
  new URL("../../../../../resources/tutorial-project/", import.meta.url)
);
const readmePath = resolve(tutorialRoot, "README.md");

function collectShortcutValues(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.values(value).flatMap(collectShortcutValues);
}

describe("tutorial project content", () => {
  it("keeps the sample file tree flat except for the walkthrough plan", () => {
    const entries = readdirSync(tutorialRoot, { withFileTypes: true })
      .filter((entry) => entry.name !== "sessions")
      .filter((entry) => entry.name !== "trackers.json");
    const directories = entries.filter((entry) => entry.isDirectory());

    expect(directories.map((entry) => entry.name)).toEqual(["planning"]);
    expect(readdirSync(resolve(tutorialRoot, "planning"))).toEqual([
      "plan-tutorial-walkthrough.md",
    ]);
    expect(existsSync(resolve(tutorialRoot, "bug-example.md"))).toBe(false);
  });

  it("contains the current intro and What to try prompts", () => {
    const readme = readFileSync(readmePath, "utf8");

    expect(readme).toContain(
      "Open the files, change some text, prompt and interact with the agent , follow a tracker reference"
    );
    expect(readme).toContain(
      "Type in this document. Try typing  / and # and @"
    );
    expect(readme).toContain("Ask the agent to make changes to the mockup");
    expect(readme).toContain(
      "Go to tracker mode (the third icon from the top on the left nav) and explore integrated trackers"
    );
    expect(readme).toContain(
      "[example bug](nimbalyst://{{TRACKER_ISSUE_KEY:EXAMPLE_BUG}})"
    );
  });

  it("keeps README file links and documented keyboard shortcuts valid", () => {
    const readme = readFileSync(readmePath, "utf8");
    const markdownLinkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
    const relativeTargets = Array.from(readme.matchAll(markdownLinkPattern))
      .map((match) => match[1].trim().match(/^<?([^>\s]+)>?/)?.[1])
      .filter((target): target is string => Boolean(target))
      .filter((target) => !target.startsWith("#"))
      .filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target));

    expect(relativeTargets.length).toBeGreaterThan(0);
    for (const target of relativeTargets) {
      const linkedPath = resolve(tutorialRoot, decodeURIComponent(target));
      const templateRelativePath = relative(tutorialRoot, linkedPath);
      const leavesTemplate =
        templateRelativePath === ".." ||
        templateRelativePath.startsWith(`..${sep}`) ||
        isAbsolute(templateRelativePath);
      expect(
        leavesTemplate,
        `README link leaves the tutorial template: ${target}`
      ).toBe(false);
      expect(
        existsSync(linkedPath),
        `README link does not resolve to a file: ${target}`
      ).toBe(true);
      expect(statSync(linkedPath).isFile()).toBe(true);
    }

    const shortcutSection = readme.match(
      /## Keyboard shortcuts\n([\s\S]*?)(?:\n## |\s*$)/
    )?.[1];
    expect(shortcutSection).toBeDefined();

    const documentedShortcuts = shortcutSection!
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .filter((line) => !line.includes("| ---"))
      .slice(1)
      .map((line) => line.split("|")[2]?.trim().replace(/`/g, ""))
      .filter((shortcut): shortcut is string => Boolean(shortcut));
    const appShortcuts = new Set(collectShortcutValues(KeyboardShortcuts));

    expect(documentedShortcuts.length).toBeGreaterThan(0);
    for (const shortcut of documentedShortcuts) {
      expect(
        appShortcuts.has(shortcut),
        `README shortcut is not defined in KeyboardShortcuts.ts: ${shortcut}`
      ).toBe(true);
    }
  });

  // A truncated screenshot in the first tutorial session rendered as a broken
  // image (GitHub #1889). Messages store their content as escaped JSON, so the
  // payloads are matched in the raw file text.
  it("embeds only complete, decodable images in the sample sessions", () => {
    const sessionsDir = resolve(tutorialRoot, "sessions");
    const payload = /\\"media_type\\":\\"(image\/[a-z]+)\\",\\"data\\":\\"([^"\\]*)\\"/g;
    let images = 0;
    for (const file of readdirSync(sessionsDir).filter((name) => name.endsWith(".json"))) {
      const text = readFileSync(resolve(sessionsDir, file), "utf8");
      for (const [, mediaType, data] of text.matchAll(payload)) {
        images++;
        const bytes = Buffer.from(data, "base64");
        expect(bytes.toString("base64"), `${file}: ${mediaType} is not canonical base64`).toBe(data);
        if (mediaType === "image/jpeg") {
          expect(bytes.subarray(0, 3).toString("hex"), `${file}: JPEG start`).toBe("ffd8ff");
          expect(bytes.subarray(-2).toString("hex"), `${file}: JPEG end`).toBe("ffd9");
        }
      }
    }
    expect(images).toBeGreaterThan(0);
  });
});
