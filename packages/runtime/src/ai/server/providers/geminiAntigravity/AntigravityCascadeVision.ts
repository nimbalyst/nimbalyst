/**
 * Image (and PDF) understanding for the `antigravity-gemini-agent` provider.
 *
 * `GetModelResponse` -- the RPC the tool loop is built on -- carries a text
 * `prompt` and a `model` and nothing else; the request message has no media
 * field at all (checked against the descriptor embedded in Antigravity
 * 2.24.0's language_server). So attached images used to be dropped on the
 * floor, and the model "answered" by reading file metadata through tools.
 *
 * The only language-server surface that accepts media is Cascade, the
 * server-side agent. Cascade runs its OWN tools inside the language server,
 * which would bypass Nimbalyst's workspace jail and its edit attribution, so it
 * is not used to run the turn. It is used for one narrow, tool-free step: show
 * the attachments to the same model the session is on, with the user's
 * request, and get back a visual analysis. That analysis is handed to the
 * normal tool loop, so the turn still executes through Nimbalyst's tools.
 *
 * Measured against Antigravity 2.24.0: `SendUserCascadeMessage.media` with
 * `{mimeType, inlineData}` reaches the model (a synthetic red/blue/yellow test
 * image was described exactly, ~4s on Gemini 3.8 Flash). The older `images`
 * field (`ImageData{base64Data}`) is accepted by the RPC but never reaches the
 * model, which then reports that no image was attached -- so it is not used.
 *
 * The trajectory is deleted afterwards so these one-shot analyses do not pile
 * up in the user's Antigravity conversation history.
 */

/** One attachment to show the model. */
export interface CascadeVisionInput {
  /** Display name, used only in the prompt and the transcript. */
  name: string;
  mimeType: string;
  data: Buffer;
}

/** The slice of AntigravityServerManager this module needs (kept narrow for tests). */
export interface CascadeVisionServer {
  callRpc<T = unknown>(method: string, body: unknown, timeoutMs: number, abortSignal?: AbortSignal): Promise<T>;
  resolveModelEnum(keyOrDisplayName: string): Promise<string>;
}

export interface CascadeVisionOptions {
  userMessage: string;
  inputs: CascadeVisionInput[];
  /** Bare model key, e.g. "gemini-3.8-flash-medium", or a MODEL_* enum. */
  modelKey: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  /** Poll interval while the cascade is still running. */
  pollMs?: number;
}

/** MIME types Antigravity's Gemini models advertise in `supportedMimeTypes` and we forward. */
const SUPPORTED_MIME = /^(image\/(png|jpeg|webp|gif|heic|heif)|application\/pdf)$/i;

export function isCascadeVisionMime(mimeType: string | undefined | null): boolean {
  return !!mimeType && SUPPORTED_MIME.test(mimeType.trim());
}

/** Per-turn cap on the bytes we inline into one RPC. */
export const MAX_CASCADE_VISION_BYTES = 20 * 1024 * 1024;

export function buildVisionPrompt(userMessage: string, names: string[]): string {
  return [
    `The user attached ${names.length === 1 ? 'this file' : `these ${names.length} files`}: ${names.join(', ')}.`,
    'Their message:',
    '"""',
    userMessage.trim() || '(no text -- they only attached the file)',
    '"""',
    '',
    'Look at the attachment(s) directly. Reply with:',
    '1. A direct answer to the user\'s message, as far as the attachments allow.',
    '2. A precise description of every visual detail that could matter for follow-up work:',
    '   all visible text verbatim, layout and positions, colours (hex where clear), UI elements,',
    '   numbers, tables, and anything unusual.',
    'Do not use any tools: in this step you have no file, terminal or browser access.',
  ].join('\n');
}

interface TrajectoryStep {
  type?: string;
  plannerResponse?: { response?: string; modifiedResponse?: string };
}

/** Text of the last planner response in a GetCascadeTrajectory payload, or ''. */
export function extractCascadeAnswer(trajectoryResponse: unknown): string {
  const steps = (trajectoryResponse as { trajectory?: { steps?: TrajectoryStep[] } } | null)
    ?.trajectory?.steps ?? [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const pr = steps[i]?.plannerResponse;
    const text = pr?.modifiedResponse || pr?.response;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
}

const RUNNING_STATUSES = new Set(['CASCADE_RUN_STATUS_RUNNING', 'CASCADE_RUN_STATUS_BUSY', 'CASCADE_RUN_STATUS_CANCELING']);

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Operation cancelled')); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Operation cancelled')); }, { once: true });
  });
}

/**
 * Show `inputs` to the model through a throwaway Cascade and return its
 * analysis. Throws on transport failure, timeout, cancellation, or an empty
 * answer; the caller decides how to surface that.
 */
export async function runCascadeVision(server: CascadeVisionServer, options: CascadeVisionOptions): Promise<string> {
  const { inputs, abortSignal } = options;
  if (inputs.length === 0) throw new Error('No attachments to analyse.');
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 750;
  const deadline = Date.now() + timeoutMs;
  const model = options.modelKey.startsWith('MODEL_')
    ? options.modelKey
    : await server.resolveModelEnum(options.modelKey);

  const started = await server.callRpc<{ cascadeId?: string }>('StartCascade', {
    source: 'CORTEX_TRAJECTORY_SOURCE_SDK',
    trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
    requestedModel: model,
  }, 30_000, abortSignal);
  const cascadeId = started?.cascadeId;
  if (!cascadeId) throw new Error('Antigravity did not start an analysis session.');

  try {
    await server.callRpc('SendUserCascadeMessage', {
      cascadeId,
      items: [{ text: buildVisionPrompt(options.userMessage, inputs.map((i) => i.name)) }],
      media: inputs.map((i) => ({
        mimeType: i.mimeType,
        inlineData: i.data.toString('base64'),
        displayName: i.name,
      })),
      cascadeConfig: { plannerConfig: { requestedModel: { model }, conversational: {} } },
      blocking: true,
    }, Math.max(1_000, deadline - Date.now()), abortSignal);

    // `blocking` normally returns after the planner finishes; poll anyway so a
    // server that returns early still yields the final answer.
    for (;;) {
      const traj = await server.callRpc<{ status?: string }>('GetCascadeTrajectory', { cascadeId }, 30_000, abortSignal);
      const answer = extractCascadeAnswer(traj);
      if (!RUNNING_STATUSES.has(traj?.status ?? '')) {
        if (!answer) throw new Error('Gemini returned no analysis for the attachment.');
        return answer;
      }
      if (Date.now() + pollMs > deadline) {
        throw new Error(`Gemini image analysis timed out after ${Math.round(timeoutMs / 1000)}s.`);
      }
      await delay(pollMs, abortSignal);
    }
  } finally {
    // Best-effort cleanup; never let it mask the real outcome.
    server.callRpc('DeleteCascadeTrajectory', { cascadeId }, 10_000).catch(() => undefined);
  }
}
