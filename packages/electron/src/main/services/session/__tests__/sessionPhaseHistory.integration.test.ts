import { beforeEach, describe, expect, it } from "vitest";

import { createPGLiteSessionStore } from "../../PGLiteSessionStore";

/**
 * Integration coverage for the phase-history capture wired into
 * SessionStore.updateMetadata. Uses a fake db that simulates the PGLite path
 * (metadata returns as a parsed object) and records the persisted blob, so we
 * can assert that successive phase changes accumulate `activity[]` entries
 * without standing up a real database.
 */
function makeFakeDb(initialMetadata: Record<string, unknown> | null) {
  const state = { metadata: initialMetadata as unknown };
  return {
    state,
    async query<T = any>(
      sql: string,
      params: any[] = []
    ): Promise<{ rows: T[] }> {
      const trimmed = sql.trim();
      if (trimmed.startsWith("SELECT metadata FROM ai_sessions")) {
        return { rows: [{ metadata: state.metadata }] as unknown as T[] };
      }
      if (/^UPDATE ai_sessions\s+SET/i.test(trimmed)) {
        const expected = params[1] as string | null;
        const replacement = params[2] as string;
        const current =
          state.metadata === null || state.metadata === undefined
            ? null
            : typeof state.metadata === "string"
            ? state.metadata
            : JSON.stringify(state.metadata);
        if (current !== expected) return { rows: [] };
        state.metadata = JSON.parse(replacement);
        return {
          rows: [{ metadata: state.metadata }] as unknown as T[],
        };
      }
      return { rows: [] };
    },
  };
}

describe("session phase history (updateMetadata integration)", () => {
  let db: ReturnType<typeof makeFakeDb>;

  beforeEach(() => {
    db = makeFakeDb({ tags: ["ai"] });
  });

  it("accumulates one status_changed entry per phase change", async () => {
    const store = createPGLiteSessionStore(db as any, async () => {});

    await store.updateMetadata("s1", {
      metadata: { phase: "planning" },
    } as any);
    await store.updateMetadata("s1", {
      metadata: { phase: "implementing" },
    } as any);
    await store.updateMetadata("s1", {
      metadata: { phase: "validating" },
    } as any);

    const persisted = db.state.metadata as Record<string, any>;
    expect(persisted.phase).toBe("validating");
    expect(persisted.tags).toEqual(["ai"]); // untouched metadata preserved
    expect(persisted.activity).toHaveLength(3);
    expect(persisted.activity.map((a: any) => a.newValue)).toEqual([
      "planning",
      "implementing",
      "validating",
    ]);
    expect(
      persisted.activity.every(
        (a: any) => a.action === "status_changed" && a.field === "phase"
      )
    ).toBe(true);
    // Each transition records the prior phase.
    expect(persisted.activity[1]).toMatchObject({
      oldValue: "planning",
      newValue: "implementing",
    });
  });

  it("does not append when the phase is unchanged", async () => {
    db = makeFakeDb({ phase: "implementing", activity: [{ id: "a0" }] });
    const store = createPGLiteSessionStore(db as any, async () => {});

    await store.updateMetadata("s1", {
      metadata: { phase: "implementing" },
    } as any);

    const persisted = db.state.metadata as Record<string, any>;
    expect(persisted.activity).toHaveLength(1);
  });

  it("returns no row and preserves state on a genuine compare-and-set miss", async () => {
    const before = JSON.stringify(db.state.metadata);
    const result = await db.query(
      `UPDATE ai_sessions
       SET metadata = $3::jsonb
       WHERE id = $1 AND metadata = $2::jsonb
       RETURNING metadata`,
      [
        "s1",
        JSON.stringify({ tags: ["stale"] }),
        JSON.stringify({ phase: "validating" }),
      ]
    );

    expect(result.rows).toEqual([]);
    expect(JSON.stringify(db.state.metadata)).toBe(before);
  });
});
