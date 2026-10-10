import {
  getCodexToolLookupAliases,
  parseCodexToolLookupId,
} from "@nimbalyst/runtime/ai/server/toolLookupIds";

export interface QuestionAnswer {
  answers: Record<string, string>;
  cancelled?: boolean;
  respondedBy: "desktop" | "mobile";
  /** Set when a new user turn closed the question instead of an answer. */
  reason?: "superseded";
}
interface Waiter {
  answer(value: QuestionAnswer): void;
  abandon(): void;
}
interface Question {
  aliases: Set<string>;
  signature: string;
  observed: boolean;
  waiter?: Waiter;
  completed: boolean;
  recover?: () => Promise<void>;
  persistCompletion?: () => Promise<void>;
  answerId?: string;
  retired?: boolean;
}
export interface QuestionTurn {
  sessionId: string;
  generation: number;
  active: boolean;
  startedAt: number;
  questions: Set<Question>;
  retirement?: Promise<void>;
}

const signature = (args: unknown): string => {
  const questions = (args as { questions?: Array<{ question?: string }> })
    ?.questions;
  return JSON.stringify(questions?.map((q) => q.question) ?? []);
};
const matches = (q: Question, id: string) =>
  getCodexToolLookupAliases(id).some((alias) => q.aliases.has(alias));

/** Owns only Codex MCP question calls, independently of their transcript widgets. */
export class CodexQuestionTurns {
  private turns = new Map<string, QuestionTurn>();
  private generation = 0;

  current(sessionId: string | undefined): QuestionTurn | undefined {
    return sessionId ? this.turns.get(sessionId) : undefined;
  }

  begin(sessionId: string): QuestionTurn {
    const previous = this.current(sessionId);
    if (previous?.active)
      throw new Error("Cannot start overlapping Codex question turns");
    const turn = {
      sessionId,
      generation: ++this.generation,
      active: true,
      startedAt: Date.now(),
      questions: new Set<Question>(),
    };
    this.turns.set(sessionId, turn);
    return turn;
  }

  async observe(
    turn: QuestionTurn | undefined,
    call: {
      id?: string;
      name?: string;
      arguments?: unknown;
      result?: unknown;
      orphaned?: boolean;
    }
  ): Promise<void> {
    if (!turn || !call.id || !String(call.name).endsWith("AskUserQuestion"))
      return;
    let question = [...turn.questions].find((q) => matches(q, call.id!));
    if (!question && call.result === undefined) {
      const candidates = [...turn.questions].filter(
        (q) => !q.observed && q.signature === signature(call.arguments)
      );
      question = candidates.length === 1 ? candidates[0] : undefined;
      if (!question) {
        question = {
          aliases: new Set(),
          signature: signature(call.arguments),
          observed: true,
          completed: false,
        };
        turn.questions.add(question);
      }
      question.observed = true;
      getCodexToolLookupAliases(call.id).forEach((id) =>
        question!.aliases.add(id)
      );
    }
    if (!question) return;
    if (call.orphaned) {
      question.retired = true;
      question.waiter?.abandon();
      question.waiter = undefined;
    } else if (call.result !== undefined) {
      question.completed = true;
      question.recover = undefined;
      question.waiter?.abandon();
      question.waiter = undefined;
      await question.persistCompletion?.();
    }
  }

  register(
    turn: QuestionTurn | undefined,
    id: string,
    args: unknown,
    waiter: Waiter
  ): () => void {
    if (!turn?.active) {
      waiter.abandon();
      return () => {};
    }
    const candidates = [...turn.questions].filter(
      (q) =>
        !q.waiter &&
        !q.completed &&
        !q.retired &&
        q.signature === signature(args)
    );
    if (candidates.length > 1) {
      console.error(
        `[CodexQuestion] ambiguous waiter: sessionId=${turn.sessionId}, generation=${turn.generation}, questionId=${id}`
      );
      waiter.abandon();
      return () => {};
    }
    const question = candidates[0] ?? {
      aliases: new Set<string>(),
      signature: signature(args),
      observed: false,
      completed: false,
    };
    getCodexToolLookupAliases(id).forEach((alias) =>
      question.aliases.add(alias)
    );
    question.waiter = waiter;
    turn.questions.add(question);
    return () => {
      if (question.waiter === waiter) question.waiter = undefined;
      question.retired = true;
    };
  }

  private find(sessionId: string, id: string): Question | undefined {
    const turn = this.current(sessionId);
    const lookup = parseCodexToolLookupId(id);
    if (lookup && turn && lookup.timestampMs < turn.startedAt) return undefined;
    return turn && [...turn.questions].find((q) => matches(q, id));
  }

  identify(sessionId: string, id: string): string {
    const question = this.find(sessionId, id);
    if (!question) return id;
    question.answerId ??= id;
    return question.answerId;
  }

  claim(
    sessionId: string,
    id: string,
    answer: QuestionAnswer,
    recover: () => Promise<void>,
    persistCompletion: () => Promise<void>
  ): "live" | "ended" | "duplicate" {
    const turn = this.current(sessionId);
    const question = this.find(sessionId, id);
    if (
      question?.recover ||
      (question?.completed && question.persistCompletion)
    )
      return "duplicate";
    if (!turn?.active || !question?.waiter) return "ended";
    question.recover = recover;
    question.persistCompletion = persistCompletion;
    const waiter = question.waiter;
    question.waiter = undefined;
    waiter.answer(answer);
    return "live";
  }

  /** Retirement is synchronous; the returned promise only waits for recovery writes. */
  end(turn: QuestionTurn | undefined): Promise<void> {
    if (!turn?.active) return turn?.retirement ?? Promise.resolve();
    turn.active = false;
    console.info(
      `[CodexQuestion] turn retired: sessionId=${turn.sessionId}, generation=${turn.generation}`
    );
    const recoveries: Array<Promise<void>> = [];
    for (const q of turn.questions) {
      q.waiter?.abandon();
      q.waiter = undefined;
      if (q.recover && !q.completed) {
        const recover = q.recover;
        q.recover = undefined;
        recoveries.push(recover());
      }
    }
    turn.retirement = Promise.all(recoveries).then(() => undefined);
    return turn.retirement;
  }
}

export const codexQuestionTurns = new CodexQuestionTurns();
