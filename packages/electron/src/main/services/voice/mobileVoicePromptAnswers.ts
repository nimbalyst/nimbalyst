import Store from "../../utils/privateSettingsStore";
import type { InteractivePromptPayload } from "@nimbalyst/runtime/ai/server/transcript/types";
import { loadVoiceSession } from "./voiceSessionLoader";
import { resolveExactVoicePromptResponse } from "../ai/MobileSessionControlHandler";
import {
  voicePresentationAuthority,
  voicePresentationKey,
  desktopRealtimeOwnsVoice,
} from "./voicePresentationAuthority";
import {
  VoicePromptGate,
  voicePromptBinding,
  type VoicePromptLease,
} from "./mobileVoicePromptGate";
import {
  exactVoiceResponse,
  voicePromptReadout,
  voicePromptVersion,
} from "./mobileVoicePromptContract";
import type { MobileLiveRequest, MobileLiveResult } from "./mobileLiveRelay";
import { AISessionsRepository } from "@nimbalyst/runtime/storage/repositories/AISessionsRepository";
import { isSessionInWorkspace } from "./voiceIpcAuthorization";

let store: Store<Record<string, VoicePromptLease>> | undefined;
function storage(): Store<Record<string, VoicePromptLease>> {
  return (store ??= new Store({ name: "mobile-voice-prompt-answers" }));
}
const gate = new VoicePromptGate(
  (key) => storage().get(key),
  (key, value) => {
    storage().set(key, value);
  }
);

/** Called only after mobileLiveTools has validated the source host/session. */
export async function handleMobileVoicePrompt(
  request: MobileLiveRequest
): Promise<MobileLiveResult> {
  const { scope, tool } = request;
  try {
    if (!scope.sessionId)
      throw new Error("Open a session before reading its question.");
    const args = JSON.parse(request.arguments) as Record<string, unknown>;
    const binding = voicePromptBinding(scope);
    const requestedId =
      typeof args.promptId === "string" ? args.promptId : undefined;
    const token = typeof args.token === "string" ? args.token : "";
    const keyFor = (id: string) =>
      voicePresentationKey(
        scope.hostDeviceId,
        scope.projectId,
        `${scope.sessionId}:${id}`
      );
    if (tool === "voice_prompt_status") {
      if (!requestedId) throw new Error("Missing prompt identity.");
      return gate.status(keyFor(requestedId), binding, token);
    }
    const loaded = await loadVoiceSession(scope.projectId, scope.sessionId);
    if ("error" in loaded || loaded.sessionId !== scope.sessionId)
      throw new Error("The source session is unavailable.");
    const owner = await AISessionsRepository.get(scope.sessionId);
    if (
      !isSessionInWorkspace(owner, scope.projectId) ||
      owner?.metadata?.hostDeviceId !== scope.hostDeviceId
    )
      throw new Error("The session ownership changed.");
    const messages: Array<{
      type: string;
      id?: string | number;
      interactivePrompt?: InteractivePromptPayload;
    }> = loaded.session.messages ?? [];
    const pending = messages
      .filter(
        (m) =>
          m.type === "interactive_prompt" &&
          m.interactivePrompt?.status === "pending"
      )
      .map((m) => m.interactivePrompt as InteractivePromptPayload)
      .filter((p) => !requestedId || p.requestId === requestedId);
    if (pending.length !== 1)
      throw new Error(
        "There is no single matching pending question. Use its app card."
      );
    const prompt = pending[0];
    const taskId = String(
      [...messages].reverse().find((m) => m.type === "user_message")?.id ??
        scope.sessionId
    );
    const version = voicePromptVersion(prompt, taskId);
    const key = keyFor(prompt.requestId);
    const presentationKey = voicePresentationKey(
      scope.hostDeviceId,
      scope.projectId,
      prompt.requestId
    );
    if (tool === "voice_prompt_prepare") {
      if (desktopRealtimeOwnsVoice())
        throw new Error(
          "The desktop voice conversation owns prompt presentation. Use its question or the app card."
        );
      if (token) gate.validate(key, binding, version, token);
      const readout = voicePromptReadout(
        prompt,
        String(loaded.session.title ?? "Session")
      );
      const claim = voicePresentationAuthority.claim(
        presentationKey,
        scope.announcingDeviceId
      );
      if (!claim)
        throw new Error(
          "Another device owns or already presented this question. Use its app card."
        );
      const lease = gate.prepare(key, binding, version);
      return {
        success: true,
        result: JSON.stringify({
          promptId: prompt.requestId,
          sessionId: scope.sessionId,
          version,
          token: lease.token,
          claimToken: claim.token,
          readout,
          ttlMs: Math.min(120000, claim.expiresAt - Date.now()),
        }),
      };
    }
    if (
      args.version !== version ||
      typeof args.claimToken !== "string" ||
      !voicePresentationAuthority.valid(
        presentationKey,
        scope.announcingDeviceId,
        args.claimToken
      )
    )
      throw new Error(
        "This proposal changed or presentation ownership expired. Read it again."
      );
    if (tool === "voice_prompt_presented") {
      gate.presented(key, binding, version, token);
      return {
        success: true,
        result: JSON.stringify({
          status: "presented",
          promptId: prompt.requestId,
        }),
      };
    }
    if (tool !== "voice_prompt_answer" || typeof args.answer !== "string")
      throw new Error("Invalid prompt operation.");
    const payload = exactVoiceResponse(prompt, args.answer);
    return await gate.answer(
      key,
      binding,
      version,
      token,
      scope.actionId,
      async () => {
        const result = await resolveExactVoicePromptResponse(
          scope.sessionId!,
          payload
        );
        if (result.success)
          voicePresentationAuthority.presented(
            presentationKey,
            scope.announcingDeviceId,
            args.claimToken as string
          );
        return result;
      }
    );
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not answer this prompt.",
    };
  }
}
