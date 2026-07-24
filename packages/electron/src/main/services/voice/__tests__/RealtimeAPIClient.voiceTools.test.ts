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
    const names = makeClient().buildSessionTools().map((t) => t.name);
    expect(names).toContain('ask_coding_agent');
    expect(names).not.toContain('memory_search');
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
});
