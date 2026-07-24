export interface VoiceSessionCreationResult {
  success: boolean;
  sessionId?: string;
  title?: string;
  error?: string;
}

/**
 * Keeps a voice-requested session creation and its next coding prompt bound
 * together without relying on the renderer's asynchronous active-session
 * navigation. Repeated create_session calls share the same result until the
 * first follow-up prompt claims the new session.
 */
export function createVoiceSessionHandoff() {
  let createdSession: VoiceSessionCreationResult | null = null;
  let creationInFlight: Promise<VoiceSessionCreationResult> | null = null;

  return {
    async createSessionOnce(
      createSession: () => Promise<VoiceSessionCreationResult>,
    ): Promise<VoiceSessionCreationResult> {
      if (createdSession?.success && createdSession.sessionId) {
        return createdSession;
      }
      if (creationInFlight) {
        return creationInFlight;
      }

      const currentCreation = createSession().then((result) => {
        if (result.success && result.sessionId) {
          createdSession = result;
        }
        return result;
      });
      creationInFlight = currentCreation;

      try {
        return await currentCreation;
      } finally {
        if (creationInFlight === currentCreation) {
          creationInFlight = null;
        }
      }
    },

    takePromptTarget(activeSessionId: string): string {
      const targetSessionId = createdSession?.sessionId ?? activeSessionId;
      createdSession = null;
      return targetSessionId;
    },
  };
}
