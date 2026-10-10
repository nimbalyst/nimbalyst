import { AISessionsRepository } from '../../../storage/repositories/AISessionsRepository';

/**
 * Reads `metadata.sessionDirective` once per session and freezes it.
 *
 * The directive is part of the system prompt, which providers re-send at the
 * head of the prompt-cache prefix every turn (NIM-1988): a value that changed
 * mid-session would bust the whole cache. A failed read freezes to "no
 * directive" for the same reason.
 */
export class FrozenSessionDirectives {
  private readonly frozen = new Map<string, Promise<string | undefined>>();

  get(sessionId?: string): Promise<string | undefined> {
    if (!sessionId) return Promise.resolve(undefined);
    let directive = this.frozen.get(sessionId);
    if (!directive) {
      directive = Promise.resolve()
        .then(() => AISessionsRepository.get(sessionId))
        .then((session) => {
          const value = (session?.metadata as Record<string, unknown> | undefined)?.sessionDirective;
          return typeof value === 'string' && value.trim() ? value : undefined;
        })
        .catch(() => undefined);
      this.frozen.set(sessionId, directive);
    }
    return directive;
  }
}
