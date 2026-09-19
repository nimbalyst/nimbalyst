// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { AntigravityServerManager } from '../AntigravityServerManager';

// The server's `ModelDetails.maxTokens` is the CONTEXT WINDOW, while
// `maxTokens` everywhere else in Nimbalyst means the output cap -- see
// `ModelDefinition` in modelConstants.ts, which carries `maxTokens: 8192`
// alongside a separate `contextWindow`. Mapping one onto the other would hand
// a future consumer a 1,048,576-token "output limit", and the field that
// actually bounds a response was not being read at all. Numbers confirmed
// live against GetAvailableModels.
describe('AntigravityServerManager.getAvailableModels -- token fields', () => {
  function managerReturning(models: Record<string, unknown>) {
    const manager = new AntigravityServerManager();
    vi.spyOn(manager as unknown as { rpc: () => Promise<unknown> }, 'rpc').mockResolvedValue({
      response: { models },
    });
    return manager;
  }

  it('keeps the context window and the output ceiling apart', async () => {
    const manager = managerReturning({
      'gemini-3.8-flash-high': {
        model: 'MODEL_PLACEHOLDER_M318',
        displayName: 'Gemini 3.8 Flash (High)',
        maxTokens: 1_048_576,
        maxOutputTokens: 65_536,
      },
    });

    const info = (await manager.getAvailableModels({ httpsPort: 1, csrf: 'x', owned: false }))
      .get('gemini-3.8-flash-high');

    expect(info?.contextWindowTokens).toBe(1_048_576);
    expect(info?.maxOutputTokens).toBe(65_536);
    // The output ceiling must never pick up the context window.
    expect(info?.maxOutputTokens).not.toBe(1_048_576);
  });

  it('leaves both undefined for a model that declares no token fields', async () => {
    // gemini-3.1-flash-image, the one image model in the live catalog.
    const manager = managerReturning({ 'gemini-3.1-flash-image': { model: 'M999', displayName: 'Image' } });

    const info = (await manager.getAvailableModels({ httpsPort: 1, csrf: 'x', owned: false }))
      .get('gemini-3.1-flash-image');

    expect(info?.contextWindowTokens).toBeUndefined();
    expect(info?.maxOutputTokens).toBeUndefined();
  });
});
