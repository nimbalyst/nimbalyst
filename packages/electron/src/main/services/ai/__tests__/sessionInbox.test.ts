// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SQLiteDatabase } from "../../../database/sqlite/SQLiteDatabase";
import { runTransactionStatements } from "../../../database/transactionStatements";
import { SessionInbox, type InboxDatabase } from "../sessionInbox";
import { createPGLiteQueuedPromptsStore } from "../../PGLiteQueuedPromptsStore";

describe.each(["pglite", "sqlite"])("session inbox (%s)", (backend) => {
  let db: InboxDatabase;
  let close: () => Promise<void>;
  let dir: string;
  beforeAll(async () => {
    if (backend === "pglite") {
      const pg = new PGlite();
      await pg.exec(`CREATE TABLE ai_sessions(id TEXT PRIMARY KEY, provider TEXT, status TEXT);
        CREATE TABLE ai_agent_messages(id SERIAL PRIMARY KEY, session_id TEXT, source TEXT, direction TEXT, content TEXT, metadata JSONB, provider_message_id TEXT, message_kind TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
        CREATE TABLE queued_prompts(id TEXT PRIMARY KEY, session_id TEXT, prompt TEXT, status TEXT DEFAULT 'pending', document_context JSONB, attachments JSONB, created_at TIMESTAMPTZ DEFAULT NOW(), claimed_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, error_message TEXT);`);
      db = {
        query: (sql, params) => pg.query(sql, params),
        runTransaction: (statements) =>
          pg.transaction((tx) => runTransactionStatements(tx, statements)),
      };
      close = () => pg.close();
    } else {
      dir = await mkdtemp(path.join(tmpdir(), "session-inbox-"));
      const sqlite = new SQLiteDatabase({
        dbDir: dir,
        schemaDir: path.resolve(__dirname, "../../../database/sqlite/schemas"),
      });
      await sqlite.initialize();
      db = sqlite;
      close = () => sqlite.close();
    }
  });
  beforeEach(async () => {
    await db.query("DELETE FROM queued_prompts");
    await db.query("DELETE FROM ai_agent_messages");
    await db.query("DELETE FROM ai_sessions");
  });
  afterAll(async () => {
    await close?.();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  let counter = 0;
  async function fixture(
    overrides: Partial<InboxDatabase> = {},
    isRunning = () => true
  ) {
    const sessionId = `inbox-${++counter}`;
    await db.query(
      "INSERT INTO ai_sessions(id,provider,status) VALUES ($1,'claude-code','running')",
      [sessionId]
    );
    const inbox = new SessionInbox(
      {
        ...db,
        query: db.query.bind(db),
        runTransaction: db.runTransaction.bind(db),
        ...overrides,
      },
      undefined,
      isRunning
    );
    const turn = await inbox.begin(sessionId, "/workspace");
    await db.query(
      "INSERT INTO ai_agent_messages(session_id, source, direction, content) VALUES ($1, 'claude-code', 'input', 'work')",
      [sessionId]
    );
    await db.query(
      "INSERT INTO ai_agent_messages(session_id, source, direction, content) VALUES ($1, 'claude-code', 'output', $2)",
      [
        sessionId,
        JSON.stringify({
          message: {
            content: [
              {
                type: "tool_use",
                id: "call-1",
                name: "mcp__nimbalyst-host__consume_session_inbox",
                input: { checkpointId: "check-1" },
              },
            ],
          },
        }),
      ]
    );
    const enqueue = async (id: string, kind = "report", text = id) =>
      db.query(
        "INSERT INTO queued_prompts(id, session_id, prompt, document_context) VALUES ($1,$2,$3,$4)",
        [
          `${sessionId}-${id}`,
          sessionId,
          text,
          JSON.stringify({
            promptProvenance: {
              actor: "agent",
              origin: "session-orchestration",
              originSessionId: "child",
              messageKind: kind,
            },
          }),
        ]
      );
    return {
      inbox,
      turn,
      sessionId,
      enqueue,
      consume: (checkpointId = "check-1") =>
        inbox.consume(sessionId, "/workspace", {
          checkpointId,
          toolUseId: "call-1",
        }),
    };
  }

  it("rolls back an entire guarded transaction after a competing claim", async () => {
    const f = await fixture();
    await f.enqueue("a");
    await expect(
      db.runTransaction([
        {
          sql: "UPDATE queued_prompts SET status='executing' WHERE session_id=$1 RETURNING id",
          params: [f.sessionId],
          expectedRows: 1,
        },
        {
          sql: "SELECT id FROM queued_prompts WHERE id='missing'",
          expectedRows: 1,
        },
      ])
    ).rejects.toThrow("Transaction conflict");
    expect(
      (
        await db.query(
          "SELECT status FROM queued_prompts WHERE session_id=$1",
          [f.sessionId]
        )
      ).rows[0].status
    ).toBe("pending");
  });

  it("receives once inside an active turn, preserves barriers, and settles exact members", async () => {
    const f = await fixture();
    await f.enqueue("a");
    await f.enqueue("b");
    await f.enqueue("c", "instruction");
    await f.enqueue("d");
    const result = JSON.parse(await f.consume());
    expect(result.messages.map((m: any) => m.text)).toEqual(["a", "b"]);
    expect(result.boundary).toBe("instruction-or-untyped-message");
    expect(await f.consume()).toBe(JSON.stringify(result));
    expect(
      (
        await db.query(
          "SELECT id FROM ai_agent_messages WHERE session_id=$1 AND source='session-inbox'",
          [f.sessionId]
        )
      ).rows
    ).toHaveLength(1);
    await f.inbox.end(f.turn, true);
    expect(
      (
        await db.query(
          "SELECT status FROM queued_prompts WHERE session_id=$1 ORDER BY id",
          [f.sessionId]
        )
      ).rows.map((r) => r.status)
    ).toEqual(["completed", "completed", "pending", "pending"]);
    await expect(f.consume()).rejects.toThrow("active session turn");
  });

  it("does not expose stale calls, foreign workspaces, or oversized reports", async () => {
    const f = await fixture();
    await f.enqueue("a", "report", "x".repeat(24_000));
    expect(JSON.parse(await f.consume()).messages).toEqual([]);
    await expect(
      f.inbox.consume(f.sessionId, "/foreign", {
        checkpointId: "x",
        toolUseId: "call-1",
      })
    ).rejects.toThrow("active session turn");
    await f.inbox.end(f.turn, false);
    await f.inbox.begin(f.sessionId, "/workspace");
    await expect(f.consume("new-1")).rejects.toThrow("verify a current");
    expect(
      (
        await db.query(
          "SELECT status FROM queued_prompts WHERE session_id=$1",
          [f.sessionId]
        )
      ).rows[0].status
    ).toBe("pending");
  });

  it("serializes checkpoints and keeps interrupted receipts out of the pending queue", async () => {
    const f = await fixture();
    await f.enqueue("a");
    const results = await Promise.all([f.consume(), f.consume()]);
    expect(results[0]).toBe(results[1]);
    await f.inbox.end(f.turn, false);
    expect(
      (
        await db.query(
          "SELECT status,error_message FROM queued_prompts WHERE session_id=$1",
          [f.sessionId]
        )
      ).rows[0]
    ).toMatchObject({
      status: "failed",
      error_message: expect.stringContaining("uncertain"),
    });
  });

  it("persists empty reads, rejects completed unreceived calls, and authenticates retries", async () => {
    const f = await fixture();
    const empty = await f.consume();
    await f.enqueue("later");
    expect(await f.consume()).toBe(empty);
    await expect(
      f.inbox.consume(f.sessionId, "/workspace", {
        checkpointId: "check-1",
        toolUseId: "foreign",
      })
    ).rejects.toThrow("verify a current");
    const g = await fixture();
    await g.enqueue("a");
    await db.query(
      "INSERT INTO ai_agent_messages(session_id,source,direction,content) VALUES ($1,'claude-code','output',$2)",
      [
        g.sessionId,
        JSON.stringify({
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "call-1" }],
          },
        }),
      ]
    );
    await expect(g.consume()).rejects.toThrow("already completed");
    expect(
      (
        await db.query(
          "SELECT status FROM queued_prompts WHERE session_id=$1",
          [g.sessionId]
        )
      ).rows[0].status
    ).toBe("pending");
  });

  it("correlates Codex checkpoints by native turn, thread and exact arguments", async () => {
    const f = await fixture();
    await f.enqueue("a");
    for (const [id, checkpointId] of [
      ["codex-1", "codex-check"],
      ["codex-2", "other-check"],
    ]) {
      await db.query(
        "INSERT INTO ai_agent_messages(session_id,source,direction,content) VALUES ($1,'openai-codex','output',$2)",
        [
          f.sessionId,
          JSON.stringify({
            method: "item/started",
            params: {
              turnId: "native-turn",
              threadId: "native-thread",
              item: {
                id,
                type: "mcpToolCall",
                tool: "consume_session_inbox",
                arguments: JSON.stringify({ checkpointId }),
              },
            },
          }),
        ]
      );
    }
    const caller = {
      checkpointId: "codex-check",
      nativeTurnId: "native-turn",
      nativeThreadId: "native-thread",
    };
    await expect(
      f.inbox.consume(f.sessionId, "/workspace", {
        ...caller,
        nativeTurnId: "old-turn",
      })
    ).rejects.toThrow("verify a current");
    const result = await f.inbox.consume(f.sessionId, "/workspace", caller);
    expect(JSON.parse(result).messages[0].text).toBe("a");
    expect(await f.inbox.consume(f.sessionId, "/workspace", caller)).toBe(
      result
    );
    await f.enqueue("later");
    for (const [method, id] of [
      ["item/completed", "codex-1"],
      ["item/started", "codex-retry"],
    ]) {
      await db.query(
        "INSERT INTO ai_agent_messages(session_id,source,direction,content) VALUES ($1,'openai-codex','output',$2)",
        [
          f.sessionId,
          JSON.stringify({
            method,
            params: {
              turnId: "native-turn",
              threadId: "native-thread",
              item: {
                id,
                type: "mcpToolCall",
                tool: "consume_session_inbox",
                arguments: { checkpointId: "codex-check" },
              },
            },
          }),
        ]
      );
    }
    expect(await f.inbox.consume(f.sessionId, "/workspace", caller)).toBe(
      result
    );
    expect(
      (
        await db.query("SELECT status FROM queued_prompts WHERE id=$1", [
          `${f.sessionId}-later`,
        ])
      ).rows[0].status
    ).toBe("pending");
    await f.inbox.end(f.turn, true);
  });

  it("rolls back claims when raw receipt persistence fails, and rejects pauses during a claim", async () => {
    const f = await fixture({
      runTransaction: (statements) =>
        db.runTransaction([
          ...statements.slice(0, -1),
          { sql: "INSERT INTO missing_receipt_table(id) VALUES (1)" },
        ]),
    });
    await f.enqueue("a");
    await expect(f.consume()).rejects.toThrow();
    expect(
      (
        await db.query(
          "SELECT status FROM queued_prompts WHERE session_id=$1",
          [f.sessionId]
        )
      ).rows[0].status
    ).toBe("pending");
    const g = await fixture({
      runTransaction: async (statements) => {
        await db.query(
          "UPDATE ai_sessions SET status='waiting_for_input' WHERE id=$1",
          [g.sessionId]
        );
        await db.runTransaction(statements);
      },
    });
    await g.enqueue("a");
    await expect(g.consume()).rejects.toThrow("Transaction conflict");
    expect(
      (
        await db.query(
          "SELECT id FROM ai_agent_messages WHERE session_id=$1 AND source='session-inbox'",
          [g.sessionId]
        )
      ).rows
    ).toEqual([]);
  });

  it("returns a committed receipt when a pause follows the claim", async () => {
    let running = true;
    const f = await fixture(
      {
        runTransaction: async (statements) => {
          await db.runTransaction(statements);
          running = false;
        },
      },
      () => running
    );
    await f.enqueue("a");
    expect(JSON.parse(await f.consume()).messages[0].text).toBe("a");
    await f.inbox.end(f.turn, true);
  });

  it("keeps original reports when an edit, attachment or human boundary wins", async () => {
    const f = await fixture({
      runTransaction: async (statements) => {
        await db.query(
          "UPDATE queued_prompts SET prompt='edited' WHERE session_id=$1",
          [f.sessionId]
        );
        await db.runTransaction(statements);
      },
    });
    await f.enqueue("a");
    await expect(f.consume()).rejects.toThrow("Transaction conflict");
    for (const context of [
      { promptProvenance: { actor: "human", origin: "composer" } },
      {
        promptProvenance: {
          actor: "agent",
          origin: "session-orchestration",
          originSessionId: "child",
          messageKind: "report",
        },
        filePath: "/context.md",
      },
    ]) {
      const g = await fixture();
      await g.enqueue("a");
      await g.enqueue("b");
      await db.query(
        "UPDATE queued_prompts SET document_context=$2 WHERE id=$1",
        [`${g.sessionId}-a`, JSON.stringify(context)]
      );
      expect(JSON.parse(await g.consume()).messages).toEqual([]);
    }
    const h = await fixture();
    await h.enqueue("a");
    await h.enqueue("b");
    await db.query("UPDATE queued_prompts SET attachments=$2 WHERE id=$1", [
      `${h.sessionId}-a`,
      JSON.stringify([{ id: "file" }]),
    ]);
    expect(JSON.parse(await h.consume()).boundary).toBe(
      "attachments-or-document-context"
    );
  });

  it("bounds large batches and never replays uncertain receipts after restart", async () => {
    const f = await fixture();
    for (let i = 0; i < 18; i++) await f.enqueue(String(i).padStart(2, "0"));
    const result = JSON.parse(await f.consume());
    expect(result.messages).toHaveLength(16);
    expect(result.remaining).toBe(true);
    const store = createPGLiteQueuedPromptsStore(db);
    await expect(store.delete(result.messages[0].id)).rejects.toThrow(
      "already claimed"
    );
    expect(await store.rollbackAllExecuting()).toBe(0);
    expect(await store.sweepExecutingOnBoot()).toEqual({
      completed: 0,
      failed: 16,
      rolledBack: 0,
    });
    await store.complete(result.messages[0].id);
    expect(
      (
        await db.query("SELECT status FROM queued_prompts WHERE id=$1", [
          result.messages[0].id,
        ])
      ).rows[0].status
    ).toBe("failed");
    expect(
      (
        await db.query(
          "SELECT id FROM queued_prompts WHERE session_id=$1 AND status='pending'",
          [f.sessionId]
        )
      ).rows
    ).toHaveLength(2);
  });

  it("revokes in-flight claims and retries failed settlement before allowing a successor", async () => {
    let resume!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let failSettlement = true;
    const f = await fixture({
      runTransaction: async (statements) => {
        entered();
        await gate;
        await db.runTransaction(statements);
      },
      query: async (sql, params) => {
        if (sql.includes("inboxDelivery'->>'turnId'") && failSettlement) {
          failSettlement = false;
          throw new Error("settlement unavailable");
        }
        return db.query(sql, params);
      },
    });
    await f.enqueue("a");
    const receiving = expect(f.consume()).rejects.toThrow("retired turn");
    await started;
    const retiring = expect(f.inbox.end(f.turn, false)).rejects.toThrow(
      "settlement unavailable"
    );
    resume();
    await receiving;
    await retiring;
    await f.inbox.begin(f.sessionId, "/workspace");
    expect(
      (
        await db.query(
          "SELECT status FROM queued_prompts WHERE session_id=$1",
          [f.sessionId]
        )
      ).rows[0].status
    ).toBe("failed");
  });
});
