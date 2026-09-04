/**
 * Planning and writing a promotion, in two steps that cannot be collapsed.
 *
 * Promotion creates a file in the user's repository, so it must never happen as
 * a side effect of anything: `planPromotion` produces the exact bytes and hands
 * them back for a human to read, and `writePromotionPlan` writes those bytes,
 * unchanged, only when told to. The plan is not re-rendered at write time —
 * what was reviewed is what lands.
 *
 * The one hard refusal is a name collision. An existing rule file means either
 * the rule is already written or two rules want the same name, and both are
 * merge questions for a person; auto-renaming to `-2.md` would quietly split a
 * convention in half, and overwriting would destroy a reviewed, committed file
 * on a heuristic. The write is therefore an exclusive create, so even a file
 * that appears between the plan and the write cannot be clobbered.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { renderRuleMarkdown } from "./render.js";
import {
  DEFAULT_PROMOTION_THRESHOLDS,
  computePromotionSignal,
  type PromotionSignal,
  type PromotionThresholds,
} from "./signal.js";
import type { PromotableMemory } from "./types.js";

export type PromotionPlanStatus =
  /** Nothing is in the way; the caller may write after a human says yes. */
  | "ready"
  /** A rule file of that name already exists. Needs a person, not a suffix. */
  | "collision";

export interface PromotionPlan {
  status: PromotionPlanStatus;
  /** Absolute directory the plan was validated against. */
  rulesDir: string;
  /** Absolute path that would be created. */
  targetPath: string;
  /** Same path relative to the rules directory, for showing a human. */
  fileName: string;
  /** The complete file. Show this before writing; write exactly this. */
  contents: string;
  /**
   * Evidence for the promotion question. Weak evidence never blocks the write:
   * it is a reason to put the signal in front of the person deciding, and they
   * may know something the recall counters do not.
   */
  signal: PromotionSignal;
  /** Rewrites the reviewer should make, chiefly stripped tracker citations. */
  warnings: string[];
  /** Set when `status === 'collision'`. */
  collidesWith?: string;
}

export interface PlanPromotionInput {
  memory: PromotableMemory;
  /** Absolute path to the repo's `.claude/rules` directory. */
  rulesDir: string;
  thresholds?: PromotionThresholds;
  trackerKeyPrefixes?: readonly string[];
  /** Injected for deterministic provenance lines. */
  now?: Date;
}

export async function planPromotion(
  input: PlanPromotionInput
): Promise<PromotionPlan> {
  const { memory, rulesDir } = input;
  if (!isAbsolute(rulesDir)) {
    throw new Error(
      `rulesDir must be an absolute path, got ${JSON.stringify(rulesDir)}`
    );
  }

  const signal = computePromotionSignal(
    memory,
    input.thresholds ?? DEFAULT_PROMOTION_THRESHOLDS
  );
  const rendered = renderRuleMarkdown(memory, {
    now: input.now,
    trackerKeyPrefixes: input.trackerKeyPrefixes,
    signal,
  });

  const targetPath = resolve(rulesDir, rendered.fileName);
  // Defence in depth against a slug that somehow escapes: nothing this writes
  // may land outside the rules directory.
  const inside = relative(resolve(rulesDir), targetPath);
  if (inside.startsWith("..") || inside.includes(sep) || inside === "") {
    throw new Error(
      `Refusing to promote outside the rules directory: ${targetPath}`
    );
  }

  const existing = await existingRuleFiles(rulesDir);
  const collision = existing.find(
    (name) => name.toLowerCase() === rendered.fileName.toLowerCase()
  );

  return {
    status: collision ? "collision" : "ready",
    rulesDir: resolve(rulesDir),
    targetPath,
    fileName: rendered.fileName,
    contents: rendered.contents,
    signal,
    warnings: rendered.warnings,
    ...(collision ? { collidesWith: join(rulesDir, collision) } : {}),
  };
}

async function existingRuleFiles(rulesDir: string): Promise<string[]> {
  try {
    return await readdir(rulesDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export interface WritePromotionOptions {
  /**
   * Must be `true`, and means a person has read `plan.contents`. It exists so
   * "the human approved this" is a value the code can require rather than a
   * convention a caller can forget.
   */
  confirm: true;
}

export interface PromotionWriteResult {
  path: string;
  bytesWritten: number;
}

export async function writePromotionPlan(
  plan: PromotionPlan,
  options: WritePromotionOptions
): Promise<PromotionWriteResult> {
  if (options?.confirm !== true) {
    throw new Error(
      "Refusing to promote without confirmation: show plan.contents to the user first."
    );
  }
  if (plan.status !== "ready") {
    throw new Error(
      `Refusing to promote: ${plan.fileName} already exists at ${plan.collidesWith}. ` +
        "Merge the two rules by hand, or promote under a different title."
    );
  }

  if (!isAbsolute(plan.rulesDir) || !isAbsolute(plan.targetPath)) {
    throw new Error("Refusing to promote: plan paths must be absolute.");
  }
  const expectedTarget = resolve(plan.rulesDir, plan.fileName);
  const inside = relative(resolve(plan.rulesDir), expectedTarget);
  if (
    expectedTarget !== resolve(plan.targetPath) ||
    inside.startsWith("..") ||
    inside.includes(sep) ||
    inside === ""
  ) {
    throw new Error(
      `Refusing to promote outside the rules directory: ${plan.targetPath}`
    );
  }

  await mkdir(plan.rulesDir, { recursive: true });
  try {
    // `wx` — create-or-fail. The status check above is the readable refusal;
    // this is the one that holds when the file appears in between.
    await writeFile(plan.targetPath, plan.contents, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Refusing to overwrite an existing rule file: ${plan.targetPath}. ` +
          "It was created after this promotion was planned."
      );
    }
    throw error;
  }

  return {
    path: plan.targetPath,
    bytesWritten: Buffer.byteLength(plan.contents, "utf8"),
  };
}
