import { randomUUID } from "node:crypto";
import type { TransactionStatement } from "../../database/transactionStatements";

export interface InboxDatabase {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
  runTransaction(statements: TransactionStatement[]): Promise<void>;
}
export interface InboxTurn {
  sessionId: string;
  workspacePath: string;
  id: string;
  baselineId: number;
  active: boolean;
  pending: Promise<unknown>;
  retirement?: Promise<void>;
  completed?: boolean;
}
export interface InboxCaller {
  checkpointId: string;
  toolUseId?: string;
  nativeTurnId?: string;
  nativeThreadId?: string;
}
interface InboxRow {
  id: string;
  prompt: string;
  document_context: unknown;
  attachments: unknown;
  created_at: unknown;
}
const parse = (value: any): any =>
  typeof value === "string" ? JSON.parse(value) : value;
const TOOL = "consume_session_inbox";
const MAX_ROWS = 16;
const MAX_CHARS = 24_000;
export const INBOX_UNCERTAIN =
  "Inbox reports were recorded during a turn that did not finish. Delivery is uncertain; they will not be replayed automatically.";

/** A received report is context for an existing turn, never a new provider input. */
export class SessionInbox {
  private turns = new Map<string, InboxTurn>();
  constructor(
    private db: InboxDatabase,
    private claimed: (sessionId: string, id: string) => void = () => {},
    private isRunning: (sessionId: string) => boolean = () => true
  ) {}

  async begin(sessionId: string, workspacePath: string): Promise<InboxTurn> {
    await this.end(this.turns.get(sessionId), false);
    const { rows } = await this.db.query(
      "SELECT MAX(id) AS id FROM ai_agent_messages WHERE session_id = $1",
      [sessionId]
    );
    const turn: InboxTurn = {
      sessionId,
      workspacePath,
      id: randomUUID(),
      baselineId: Number(rows[0]?.id ?? 0),
      active: true,
      pending: Promise.resolve(),
    };
    this.turns.set(sessionId, turn);
    return turn;
  }

  current(sessionId: string): InboxTurn | undefined {
    return this.turns.get(sessionId);
  }

  async end(turn: InboxTurn | undefined, completed: boolean): Promise<void> {
    if (!turn) return;
    if (turn.active) {
      // Revoke synchronously, including while a transaction is still in flight.
      turn.active = false;
      turn.completed = completed;
    }
    if (!turn.retirement) {
      turn.retirement = (async () => {
        await turn.pending.catch(() => {});
        await this.db.query(
          `UPDATE queued_prompts SET status = $2, completed_at = CURRENT_TIMESTAMP, error_message = $3
           WHERE session_id = $1 AND status = 'executing'
             AND document_context->'inboxDelivery'->>'turnId' = $4`,
          [
            turn.sessionId,
            turn.completed ? "completed" : "failed",
            turn.completed ? null : INBOX_UNCERTAIN,
            turn.id,
          ]
        );
        if (this.turns.get(turn.sessionId) === turn)
          this.turns.delete(turn.sessionId);
      })().catch((error) => {
        turn.retirement = undefined;
        throw error;
      });
    }
    return turn.retirement;
  }

  async consume(
    sessionId: string,
    workspacePath: string,
    caller: InboxCaller
  ): Promise<string> {
    const turn = this.turns.get(sessionId);
    if (
      !turn?.active ||
      turn.workspacePath !== workspacePath ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(caller.checkpointId)
    )
      throw new Error(
        "Inbox checkpoint requires the current active session turn"
      );
    const work = turn.pending
      .catch(() => {})
      .then(() => this.receive(turn, caller));
    turn.pending = work;
    return work;
  }

  private assertActive(turn: InboxTurn, requireRunning = true): void {
    if (!turn.active || this.turns.get(turn.sessionId) !== turn)
      throw new Error("Inbox checkpoint belongs to a retired turn");
    if (requireRunning && !this.isRunning(turn.sessionId))
      throw new Error(
        "Inbox consumption requires a running turn; finish interactive input first"
      );
  }

  private async receive(turn: InboxTurn, caller: InboxCaller): Promise<string> {
    this.assertActive(turn);
    // A checkpoint name is bound to a verified native invocation and this host
    // generation. Transport reconnects must not consume a second batch.
    const identity = await this.resolveInvocation(turn, caller);
    this.assertActive(turn);
    const key = `${turn.id}:${identity.inputId}:${caller.checkpointId}`;
    const prior = await this.db.query<{ content: string }>(
      `SELECT content FROM ai_agent_messages WHERE session_id = $1 AND source = 'session-inbox'
       AND provider_message_id = $2 ORDER BY id DESC LIMIT 1`,
      [turn.sessionId, key]
    );
    if (prior.rows.length) {
      this.assertActive(turn);
      return JSON.parse(prior.rows[0].content).result;
    }
    if (identity.ambiguous)
      throw new Error("Ambiguous inbox tool invocation; retry serially");
    if (identity.completed)
      throw new Error("Inbox tool invocation already completed");
    const pending = await this.db.query<InboxRow>(
      `SELECT id, prompt, document_context, attachments, created_at FROM queued_prompts
       WHERE session_id = $1 AND status = 'pending' ORDER BY created_at, id LIMIT $2`,
      [turn.sessionId, MAX_ROWS + 1]
    );
    const messages: Array<{
      id: string;
      sourceSessionId: string;
      createdAt: unknown;
      kind: string;
      text: string;
    }> = [];
    let boundary: string | null = null;
    const deliveryId = randomUUID();
    const envelope = () =>
      JSON.stringify({
        deliveryId,
        deliveryMode: "checkpoint",
        turnId: turn.id,
        messages,
        remaining: pending.rows.length > messages.length,
        boundary,
      });
    for (const row of pending.rows) {
      const context = parse(row.document_context);
      const provenance = context?.promptProvenance;
      const kind = provenance?.messageKind;
      if (
        provenance?.actor !== "agent" ||
        !provenance.originSessionId ||
        !["session-orchestration", "child-session-update"].includes(
          provenance.origin
        ) ||
        !["report", "status"].includes(kind)
      ) {
        boundary = "instruction-or-untyped-message";
        break;
      }
      if (
        parse(row.attachments)?.length ||
        Object.keys(context).some((k) => !["promptProvenance"].includes(k))
      ) {
        boundary = "attachments-or-document-context";
        break;
      }
      if (messages.length === MAX_ROWS) {
        boundary = "batch-limit";
        break;
      }
      messages.push({
        id: row.id,
        sourceSessionId: provenance.originSessionId,
        createdAt: row.created_at,
        kind,
        text: row.prompt,
      });
      if (envelope().length + 64 > MAX_CHARS) {
        messages.pop();
        boundary = "size-limit";
        break;
      }
    }
    const result = envelope();
    this.assertActive(turn);
    const memberIds = messages.map((message) => message.id);
    const statements: TransactionStatement[] = [
      {
        sql: `SELECT id FROM ai_agent_messages WHERE session_id = $1 AND direction = 'input'
            AND id = $2 AND id = (SELECT MAX(id) FROM ai_agent_messages WHERE session_id = $1 AND direction = 'input')
            AND EXISTS (SELECT 1 FROM ai_sessions WHERE id = $1 AND status = 'running')`,
        params: [turn.sessionId, identity.inputId],
        expectedRows: 1,
      },
    ];
    for (let index = 0; index < messages.length; index++) {
      const row = pending.rows[index];
      const context = parse(row.document_context);
      const inboxDelivery = {
        version: 1,
        deliveryId,
        turnId: turn.id,
        inputId: identity.inputId,
        toolCallId: identity.toolCallId,
        coordinatorId: memberIds[0],
        ...(index === 0 ? { memberIds, result, requestKey: key } : {}),
      };
      statements.push({
        // Claim the exact original prefix, not a stale list. A competing drainer,
        // edit, or delete rolls back every claim and the raw receipt together.
        sql: `UPDATE queued_prompts SET status = 'executing', claimed_at = CURRENT_TIMESTAMP, document_context = $4
              WHERE id = $1 AND session_id = $2 AND status = 'pending' AND prompt = $3
                AND document_context = $5
                AND (attachments = $6 OR (attachments IS NULL AND $6 IS NULL))
                AND id = (SELECT id FROM queued_prompts WHERE session_id = $2 AND status = 'pending' ORDER BY created_at, id LIMIT 1)
              RETURNING id`,
        params: [
          row.id,
          turn.sessionId,
          row.prompt,
          JSON.stringify({ ...context, inboxDelivery }),
          typeof row.document_context === "string"
            ? row.document_context
            : JSON.stringify(row.document_context),
          row.attachments == null
            ? null
            : typeof row.attachments === "string"
            ? row.attachments
            : JSON.stringify(row.attachments),
        ],
        expectedRows: 1,
      });
    }
    statements.push({
      sql: `INSERT INTO ai_agent_messages (session_id, source, direction, content, metadata, provider_message_id, message_kind)
            VALUES ($1, 'session-inbox', 'output', $2, $3, $4, 'meta') RETURNING id`,
      params: [
        turn.sessionId,
        JSON.stringify({
          type: "tool_result",
          tool: TOOL,
          toolCallId: identity.toolCallId,
          result,
        }),
        JSON.stringify({
          deliveryId,
          memberIds,
          turnId: turn.id,
          inputId: identity.inputId,
          toolCallId: identity.toolCallId,
        }),
        key,
      ],
      expectedRows: 1,
    });
    await this.db.runTransaction(statements);
    // The transaction determined whether the claim preceded an interactive
    // pause. Deliver that receipt even if a pause followed it; cancellation
    // still revokes this generation and settles the receipt as uncertain.
    this.assertActive(turn, false);
    for (const id of memberIds) this.claimed(turn.sessionId, id);
    return result;
  }

  private matchesCheckpoint(value: unknown, checkpointId: string): boolean {
    try {
      const args = parse(value);
      return (
        args &&
        !Array.isArray(args) &&
        Object.keys(args).length === 1 &&
        args.checkpointId === checkpointId
      );
    } catch {
      return false;
    }
  }

  private async resolveInvocation(
    turn: InboxTurn,
    caller: InboxCaller
  ): Promise<{
    inputId: number;
    toolCallId: string;
    completed: boolean;
    ambiguous: boolean;
  }> {
    // Provider raw tool records may trail the HTTP request by the write queue's
    // short flush interval. Wait for this invocation only, with a fixed bound.
    for (let attempt = 0; attempt < 25; attempt++) {
      this.assertActive(turn);
      const input = await this.db.query<{ id: number }>(
        `SELECT id FROM ai_agent_messages WHERE session_id = $1 AND direction = 'input' AND id > $2 ORDER BY id DESC LIMIT 1`,
        [turn.sessionId, turn.baselineId]
      );
      if (input.rows.length) {
        const inputId = Number(input.rows[0].id);
        const raw = await this.db.query<{ content: string }>(
          `SELECT content FROM ai_agent_messages WHERE session_id = $1 AND id > $2 AND source IN ('claude-code', 'openai-codex')
           ORDER BY id DESC LIMIT 100`,
          [turn.sessionId, inputId]
        );
        const started = new Set<string>();
        const completed = new Set<string>();
        for (const row of raw.rows) {
          let value: any;
          try {
            value = JSON.parse(row.content);
          } catch {
            continue;
          }
          const params = value?.params;
          const item = params?.item;
          if (
            caller.nativeTurnId &&
            params?.turnId === caller.nativeTurnId &&
            (!caller.nativeThreadId ||
              params?.threadId === caller.nativeThreadId) &&
            item?.type === "mcpToolCall" &&
            item.tool === TOOL &&
            typeof item.id === "string"
          ) {
            if (
              value.method === "item/started" &&
              this.matchesCheckpoint(item.arguments, caller.checkpointId)
            )
              started.add(item.id);
            if (value.method === "item/completed") completed.add(item.id);
          }
          const blocks =
            value?.message?.content ??
            (value?.type === "tool_use" || value?.type === "tool_result"
              ? [value]
              : undefined);
          if (caller.toolUseId && Array.isArray(blocks)) {
            for (const block of blocks) {
              if (
                block.type === "tool_use" &&
                block.id === caller.toolUseId &&
                [
                  TOOL,
                  `mcp__nimbalyst-host__${TOOL}`,
                  `mcp__nimbalyst__${TOOL}`,
                ].includes(block.name) &&
                this.matchesCheckpoint(block.input, caller.checkpointId)
              )
                started.add(block.id);
              if (
                block.type === "tool_result" &&
                block.tool_use_id === caller.toolUseId
              )
                completed.add(block.tool_use_id);
            }
          }
        }
        const candidates = [...started];
        const unfinished = candidates.filter((id) => !completed.has(id));
        if (candidates.length)
          return {
            inputId,
            toolCallId: unfinished[0] ?? candidates[0],
            completed: unfinished.length === 0,
            ambiguous: unfinished.length > 1,
          };
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      "Inbox checkpoint could not verify a current provider tool invocation"
    );
  }
}
