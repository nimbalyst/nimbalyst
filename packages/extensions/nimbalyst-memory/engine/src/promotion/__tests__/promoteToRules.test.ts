// @vitest-environment node
/**
 * Writing is where this feature can do damage: it creates a file in the user's
 * repository. The cases below are the ones that must hold every time — a plan
 * is never written without being confirmed, an existing rule file is never
 * overwritten (including when it appears *after* the plan was made), and the
 * bytes that land are the bytes that were reviewed.
 *
 * Everything writes to a temp directory. A stray file in `.claude/rules` is
 * exactly the failure this feature must not have, so the tests may not create
 * one either.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planPromotion, writePromotionPlan } from "../promote.js";
import type { PromotableMemory } from "../types.js";

const MEMORY: PromotableMemory = {
  id: "mem_01",
  title: "Always Run Your Own Observation Commands",
  body: "Never ask the user to run `curl`, `wrangler tail`, or `gh` and paste the output. The agent has direct tool access to all of them.",
  why: "A session spent 23 turns handing commands back to the user instead of running them.",
  recall: { recallCount: 11, sessionCount: 5 },
};

let dir: string;
let rulesDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nimbalyst-promotion-"));
  rulesDir = join(dir, ".claude", "rules");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("promotion write path", () => {
  it("writes exactly the reviewed bytes, and only when confirmed", async () => {
    const plan = await planPromotion({ memory: MEMORY, rulesDir });
    expect(plan.status).toBe("ready");
    expect(plan.signal.eligible).toBe(true);

    await expect(
      writePromotionPlan(plan, { confirm: false as unknown as true })
    ).rejects.toThrow(/without confirmation/);

    const result = await writePromotionPlan(plan, { confirm: true });
    expect(result.path).toBe(
      join(rulesDir, "always-run-your-own-observation-commands.md")
    );
    await expect(readFile(result.path, "utf8")).resolves.toBe(plan.contents);
  });

  it("reports a name collision instead of overwriting or auto-renaming", async () => {
    await mkdir(rulesDir, { recursive: true });
    const existingPath = join(
      rulesDir,
      "always-run-your-own-observation-commands.md"
    );
    await writeFile(
      existingPath,
      "## Hand-written rule\n\nDo not lose me.\n",
      "utf8"
    );

    const plan = await planPromotion({ memory: MEMORY, rulesDir });

    expect(plan.status).toBe("collision");
    expect(plan.collidesWith).toBe(existingPath);
    await expect(writePromotionPlan(plan, { confirm: true })).rejects.toThrow(
      /already exists/
    );
    await expect(readFile(existingPath, "utf8")).resolves.toContain(
      "Do not lose me."
    );
  });

  it("still refuses when the file appears between planning and writing", async () => {
    const plan = await planPromotion({ memory: MEMORY, rulesDir });
    expect(plan.status).toBe("ready");

    await mkdir(rulesDir, { recursive: true });
    await writeFile(plan.targetPath, "written by someone else\n", "utf8");

    await expect(writePromotionPlan(plan, { confirm: true })).rejects.toThrow(
      /Refusing to overwrite/
    );
    await expect(readFile(plan.targetPath, "utf8")).resolves.toBe(
      "written by someone else\n"
    );
  });

  it("revalidates the destination when a reviewed plan is tampered with", async () => {
    const plan = await planPromotion({ memory: MEMORY, rulesDir });
    const outside = join(dir, "outside.md");

    await expect(
      writePromotionPlan({ ...plan, targetPath: outside }, { confirm: true })
    ).rejects.toThrow(/outside the rules directory/);
    await expect(readFile(outside, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("plans a weak candidate rather than refusing it, and says why it is weak", async () => {
    // Evidence is the human's call; only a collision is a hard refusal.
    const plan = await planPromotion({
      memory: { ...MEMORY, recall: { recallCount: 1, sessionCount: 1 } },
      rulesDir,
    });

    expect(plan.status).toBe("ready");
    expect(plan.signal.eligible).toBe(false);
    expect(plan.signal.blockers.join(" ")).toMatch(/under the/);
    await expect(
      writePromotionPlan(plan, { confirm: true })
    ).resolves.toBeTruthy();
  });
});
