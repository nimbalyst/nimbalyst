import { config as loadEnv } from 'dotenv';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendStreamingEditWithProvider } from '../client';
import type { DocumentContext } from '../types';

loadEnv({ path: join(process.cwd(), '.env') });
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;

const LMSTUDIO_BASE_URL = process.env.LMSTUDIO_BASE_URL;
const LMSTUDIO_MODEL = process.env.LMSTUDIO_MODEL;
const LMSTUDIO_API_KEY = process.env.LMSTUDIO_API_KEY;

type ProviderId = 'openai' | 'anthropic' | 'lmstudio';

const AVAILABLE_DEFAULTS = new Set<ProviderId>(
  ([] as ProviderId[])
    .concat(OPENAI_KEY ? ['openai'] : [])
    .concat(ANTHROPIC_KEY ? ['anthropic'] : [])
    .concat(LMSTUDIO_BASE_URL ? ['lmstudio'] : [])
);

const RUN_CONFIG = (() => {
  const raw = process.env.RUN_AI_PROVIDER_TESTS;
  if (!raw) {
    return {
      enabled: false,
      providers: new Set<ProviderId>(),
    };
  }
  const normalized = raw.toLowerCase().trim();
  if (!normalized || ['off', 'false', '0', 'none'].includes(normalized)) {
    return { enabled: false, providers: new Set<ProviderId>() };
  }
  if (['true', '1', 'yes', 'on', '*', 'all'].includes(normalized)) {
    return { enabled: true, providers: new Set<ProviderId>() };
  }
  const validProviders: ProviderId[] = ['openai', 'anthropic', 'lmstudio'];
  const providers = new Set<ProviderId>(
    normalized
      .split(',')
      .map(entry => entry.trim())
      .filter((entry): entry is ProviderId => validProviders.includes(entry as ProviderId))
  );
  return { enabled: providers.size > 0, providers };
})();

const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  lmstudio: 'LM Studio',
};

function skipReason(provider: ProviderId): string {
  if (provider === 'openai' && !OPENAI_KEY) return 'OPENAI_API_KEY missing';
  if (provider === 'anthropic' && !ANTHROPIC_KEY) return 'ANTHROPIC_API_KEY missing';
  if (provider === 'lmstudio' && !LMSTUDIO_BASE_URL) return 'LMSTUDIO_BASE_URL missing';
  if (!RUN_CONFIG.enabled) return 'set RUN_AI_PROVIDER_TESTS=true (or include provider name) to run provider integrations';
  if (RUN_CONFIG.providers.size > 0 && !RUN_CONFIG.providers.has(provider)) {
    return `${provider} not enabled via RUN_AI_PROVIDER_TESTS`;
  }
  return '';
}

describe('AI provider integration', () => {
  const bridge = {
    applyReplacements: vi.fn(),
    startStreamingEdit: vi.fn(),
    streamContent: vi.fn(),
    endStreamingEdit: vi.fn(),
  };

  beforeEach(() => {
    Object.assign(bridge, {
      applyReplacements: vi.fn().mockResolvedValue({ success: true }),
      startStreamingEdit: vi.fn(),
      streamContent: vi.fn(),
      endStreamingEdit: vi.fn(),
    });

    (globalThis as any).aiChatBridge = bridge;
    (globalThis as any).window = {
      dispatchEvent: vi.fn(),
    } as any;
    (globalThis as any).CustomEvent = class {
      type: string;
      detail: any;
      constructor(type: string, init?: { detail?: any }) {
        this.type = type;
        this.detail = init?.detail;
      }
    };
  });

  afterEach(() => {
    delete (globalThis as any).aiChatBridge;
    delete (globalThis as any).window;
    delete (globalThis as any).CustomEvent;
    vi.clearAllMocks();
  });

  const baseDocument: DocumentContext = {
    filePath: '/tmp/doc.md',
    fileType: 'markdown',
    content: '# Notes\n\nThis is teh test document.\n',
  };
  const streamingDocument: DocumentContext = {
    filePath: '/tmp/streaming.md',
    fileType: 'markdown',
    content: '# Changelog\n\n- Initial entry.\n',
  };

  type ProviderRequestInput = Parameters<typeof sendStreamingEditWithProvider>[0];

  const PROVIDER_CASES: Array<{
    id: ProviderId;
    buildRequest: (prompt: string, document: DocumentContext) => ProviderRequestInput;
  }> = [
    {
      id: 'openai',
      buildRequest: (prompt, document) => ({
        provider: 'openai',
        prompt,
        document,
        apiKey: OPENAI_KEY!,
        baseUrl: OPENAI_BASE_URL,
        model: OPENAI_MODEL,
      }),
    },
    {
      id: 'anthropic',
      buildRequest: (prompt, document) => ({
        provider: 'anthropic',
        prompt,
        document,
        apiKey: ANTHROPIC_KEY!,
        baseUrl: ANTHROPIC_BASE_URL,
        model: ANTHROPIC_MODEL,
      }),
    },
    {
      id: 'lmstudio',
      buildRequest: (prompt, document) => ({
        provider: 'lmstudio',
        prompt,
        document,
        apiKey: LMSTUDIO_API_KEY || '',
        baseUrl: LMSTUDIO_BASE_URL,
        model: LMSTUDIO_MODEL || OPENAI_MODEL,
      }),
    },
  ];

  const DIFF_PROMPT = 'Fix the typo "teh" to "the" in the document. Follow instructions exactly.';
  const STREAM_PROMPT =
    'Append exactly the line "- Added streaming verification." to the end of the document using the streamContent tool. Call streamContent once with content "- Added streaming verification." and position "end". Do not call the applyDiff tool and do not replace existing lines.';

  for (const providerCase of PROVIDER_CASES) {
    const reason = skipReason(providerCase.id);
    if (reason) {
      // eslint-disable-next-line no-console
      console.warn(`[ai][skip] ${PROVIDER_LABELS[providerCase.id]} integration skipped: ${reason}`);
    }

    (reason ? it.skip : it)(
      `${PROVIDER_LABELS[providerCase.id]} handles applyDiff and streamContent tools`,
      { timeout: 120000 },
      async () => {
        const diffDoc: DocumentContext = { ...baseDocument };
        await sendStreamingEditWithProvider(
          providerCase.buildRequest(DIFF_PROMPT, diffDoc),
          {
            callbacks: {
              onContent: () => {},
            },
          }
        );

        expect(bridge.applyReplacements).toHaveBeenCalledTimes(1);
        const diffArgs = bridge.applyReplacements.mock.calls[0][0];
        expect(Array.isArray(diffArgs)).toBe(true);
        const replacement = diffArgs[0];
        expect(replacement.oldText).toContain('teh');
        expect(replacement.newText).toContain('the');

        bridge.applyReplacements.mockClear();
        bridge.startStreamingEdit.mockClear();
        bridge.streamContent.mockClear();
        bridge.endStreamingEdit.mockClear();

        const streamedChunks: string[] = [];
        const streamDoc: DocumentContext = { ...streamingDocument };

        await sendStreamingEditWithProvider(
          providerCase.buildRequest(STREAM_PROMPT, streamDoc),
          {
            callbacks: {
              onContent: (chunk: string) => {
                streamedChunks.push(chunk);
              },
            },
          }
        );

        expect(bridge.applyReplacements).not.toHaveBeenCalled();
        expect(bridge.startStreamingEdit.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(bridge.streamContent.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(bridge.endStreamingEdit.mock.calls.length).toBeGreaterThanOrEqual(1);

        const streamedPayloads = bridge.streamContent.mock.calls.map(call => call[1]);
        const streamingOutput = streamedChunks.join('') || streamedPayloads.join('');
        expect(streamingOutput).toContain('- Added streaming verification.');
      }
    );
  }
});
