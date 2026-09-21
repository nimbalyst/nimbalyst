import { createHash } from "node:crypto";
import Store from "../../utils/privateSettingsStore";

interface Reservation {
  answer: string;
  dispatched: boolean;
}
let store: Store<Record<string, Reservation>> | undefined;
/** Share the canonical response boundary across cards and mobile voice. Question
 * IDs here are request identities; Codex turn-owned questions use their own driver.
 * A UI may persist first and dispatch second, but a different answer never wins
 * in between, and delivery happens at most once even after a process restart. */
export function reservePromptAnswer(
  sessionId: string,
  kind: "question" | "permission",
  promptId: string,
  response: Record<string, unknown>,
  stage: "record" | "deliver" = "deliver"
): boolean {
  store ??= new Store({ name: "prompt-answer-reservations" });
  const key = createHash("sha256")
    .update(JSON.stringify([sessionId, kind, promptId]))
    .digest("hex");
  const value =
    kind === "permission"
      ? [response.decision, response.scope ?? "once"]
      : [
          response.cancelled === true,
          Object.entries(
            (response.answers ?? {}) as Record<string, unknown>
          ).sort(([a], [b]) => a.localeCompare(b)),
        ];
  const answer = createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
  const old = store.get(key);
  if (old && (old.answer !== answer || (stage === "deliver" && old.dispatched)))
    return false;
  store.set(key, {
    answer,
    dispatched: stage === "deliver" || old?.dispatched === true,
  });
  return true;
}
