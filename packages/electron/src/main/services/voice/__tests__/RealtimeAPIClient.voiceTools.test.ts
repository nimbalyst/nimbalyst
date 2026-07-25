import { describe, expect, it, vi } from 'vitest';

// RealtimeAPIClient imports electron (ipcMain), ws, and AnalyticsService at the
// top level. Mock them so the client can be constructed in a plain node test
// without opening a socket or pulling in posthog/electron app side effects.
vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), once: vi.fn(), removeListener: vi.fn(), removeAllListeners: vi.fn() },
}));
vi.mock('ws', () => ({ default: class {} }));
vi.mock('../../analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));

import { RealtimeAPIClient } from '../RealtimeAPIClient';
import { buildVoiceToolSet, type VoiceCapableToolDefinition } from '../voiceToolBridge';

function makeClient(): RealtimeAPIClient {
  return new RealtimeAPIClient('test-key', 'coding-session', '/workspace', {} as any);
}

const memoryTool: VoiceCapableToolDefinition = {
  name: 'memory.search',
  description: 'Search the project knowledge index',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  voiceAgent: true,
};

/** Attach a fake connected WebSocket and capture everything sent. */
function attachFakeSocket(client: RealtimeAPIClient): any[] {
  const sent: any[] = [];
  (client as any).ws = { send: (s: string) => sent.push(JSON.parse(s)) };
  (client as any).connected = true;
  return sent;
}

describe('RealtimeAPIClient extension voice tools', () => {
  it('lists built-in tools and appends extension voice tools in the session config', () => {
    const client = makeClient();
    const { schemas, nameMap } = buildVoiceToolSet([memoryTool]);
    client.setExtensionVoiceTools(schemas, nameMap);

    const names = client.buildSessionTools().map((t) => t.name);
    expect(names).toContain('submit_agent_prompt'); // a built-in is still present
    expect(names).toContain('memory_search'); // the extension tool was appended
  });

  it('lists only built-in tools when no extension voice tools are set', () => {
    const tools = makeClient().buildSessionTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('ask_coding_agent');
    expect(names).toContain('get_ui_context');
    expect(names).toContain('capture_ui_screenshot');
    expect(names).not.toContain('memory_search');
    expect(tools.find((tool) => tool.name === 'capture_ui_screenshot')?.parameters.required)
      .toEqual(['userConfirmed', 'reason']);
  });

  it('routes an extension function call to the dispatch callback and returns its result', async () => {
    const client = makeClient();
    const { schemas, nameMap } = buildVoiceToolSet([memoryTool]);
    client.setExtensionVoiceTools(schemas, nameMap);

    const dispatch = vi.fn(async (namespacedName: string) => ({
      success: true,
      message: `ran ${namespacedName}`,
    }));
    client.setOnExtensionVoiceTool(dispatch);

    const sent = attachFakeSocket(client);
    await (client as any).handleFunctionCall('call-1', 'memory_search', JSON.stringify({ query: 'hi' }));

    // Dispatched with the original namespaced (dotted) name + parsed args.
    expect(dispatch).toHaveBeenCalledWith('memory.search', { query: 'hi' });

    const fnOutput = sent.find((e) => e.item?.type === 'function_call_output');
    expect(fnOutput).toBeDefined();
    expect(JSON.parse(fnOutput.item.output)).toEqual({ success: true, message: 'ran memory.search' });
  });

  it('returns "Unknown function" for a name that is neither built-in nor a registered extension tool', async () => {
    const client = makeClient();
    const sent = attachFakeSocket(client);
    await (client as any).handleFunctionCall('call-2', 'totally_unknown', '{}');

    const fnOutput = sent.find((e) => e.item?.type === 'function_call_output');
    expect(JSON.parse(fnOutput.item.output)).toEqual({ error: 'Unknown function' });
  });

  it('reports the error when an extension tool dispatch throws', async () => {
    const client = makeClient();
    const { schemas, nameMap } = buildVoiceToolSet([memoryTool]);
    client.setExtensionVoiceTools(schemas, nameMap);
    client.setOnExtensionVoiceTool(async () => {
      throw new Error('boom');
    });

    const sent = attachFakeSocket(client);
    await (client as any).handleFunctionCall('call-3', 'memory_search', '{}');

    const fnOutput = sent.find((e) => e.item?.type === 'function_call_output');
    expect(JSON.parse(fnOutput.item.output)).toEqual({ success: false, error: 'boom' });
  });

  it('returns the fresh UI context supplied by the main-process bridge', async () => {
    const client = makeClient();
    const getUiContext = vi.fn(async () => ({
      success: true,
      context: {
        activeView: 'agent',
        selectedFile: { name: 'App.tsx', relativePath: 'src/App.tsx' },
        activeSession: { id: 'session-1', title: 'UI work', status: 'running' },
      },
    }));
    client.setOnGetUiContext(getUiContext);

    const sent = attachFakeSocket(client);
    await (client as any).handleFunctionCall('call-ui', 'get_ui_context', '{}');

    expect(getUiContext).toHaveBeenCalledTimes(1);
    const output = sent.find((event) => event.item?.type === 'function_call_output');
    expect(JSON.parse(output.item.output)).toEqual({
      success: true,
      context: {
        activeView: 'agent',
        selectedFile: { name: 'App.tsx', relativePath: 'src/App.tsx' },
        activeSession: { id: 'session-1', title: 'UI work', status: 'running' },
      },
    });
  });

  it('rejects UI screenshot capture without explicit user confirmation', async () => {
    const client = makeClient();
    const capture = vi.fn();
    client.setOnCaptureUiScreenshot(capture);

    const sent = attachFakeSocket(client);
    await (client as any).handleFunctionCall(
      'call-shot-denied',
      'capture_ui_screenshot',
      JSON.stringify({ userConfirmed: false, reason: 'inspect settings' }),
    );

    expect(capture).not.toHaveBeenCalled();
    const output = sent.find((event) => event.item?.type === 'function_call_output');
    expect(JSON.parse(output.item.output)).toEqual({
      success: false,
      error: 'Explicit user confirmation is required before capturing the UI.',
    });
  });

  it('injects a confirmed screenshot as image input and returns metadata without pixels', async () => {
    const client = makeClient();
    const imageDataUrl = `data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}`;
    const capture = vi.fn(async () => ({
      success: true,
      imageDataUrl,
      source: 'active_nimbalyst_window' as const,
      format: 'jpeg' as const,
      width: 1200,
      height: 800,
      bytes: 10,
      capturedAt: '2026-07-24T12:00:00.000Z',
      context: { activeView: 'settings' },
    }));
    client.setOnCaptureUiScreenshot(capture);

    const sent = attachFakeSocket(client);
    await (client as any).handleFunctionCall(
      'call-shot',
      'capture_ui_screenshot',
      JSON.stringify({ userConfirmed: true, reason: 'inspect settings' }),
    );

    expect(capture).toHaveBeenCalledWith('inspect settings');
    const imageEvent = sent.find((event) =>
      event.item?.content?.some((part: any) => part.type === 'input_image')
    );
    expect(imageEvent.item.content).toEqual([
      {
        type: 'input_text',
        text: '[INTERNAL: Current Nimbalyst UI screenshot captured for: inspect settings]',
      },
      {
        type: 'input_image',
        image_url: imageDataUrl,
        detail: 'high',
      },
    ]);

    const output = sent.find((event) => event.item?.type === 'function_call_output');
    expect(output.item.output).not.toContain('base64');
    expect(JSON.parse(output.item.output)).toEqual({
      success: true,
      source: 'active_nimbalyst_window',
      format: 'jpeg',
      width: 1200,
      height: 800,
      bytes: 10,
      capturedAt: '2026-07-24T12:00:00.000Z',
      context: { activeView: 'settings' },
    });
  });
});
