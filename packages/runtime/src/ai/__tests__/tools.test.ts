import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BUILT_IN_TOOLS,
  ToolRegistry,
  RuntimeToolExecutor,
} from '../tools';

describe('ToolRegistry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes with built-in tools and converts to provider formats', () => {
    const registry = new ToolRegistry();
    const names = registry.getAll().map(tool => tool.name);

    for (const builtin of BUILT_IN_TOOLS) {
      expect(names).toContain(builtin.name);
    }

    const anthropic = registry.toAnthropic();
    const openai = registry.toOpenAI();

    expect(anthropic).toHaveLength(BUILT_IN_TOOLS.length);
    expect(openai).toHaveLength(BUILT_IN_TOOLS.length);
    expect(openai[0]).toHaveProperty('function');
    expect(anthropic[0]).toHaveProperty('input_schema');
  });

  it('emits events when registering and unregistering tools', () => {
    const registry = new ToolRegistry([]);
    const onRegister = vi.fn();
    const onUnregister = vi.fn();
    registry.on('tool:registered', onRegister);
    registry.on('tool:unregistered', onUnregister);

    const tool = {
      name: 'customTool',
      description: 'Custom tool',
      parameters: {
        type: 'object' as const,
        properties: {},
      },
    };

    registry.register(tool);
    expect(onRegister).toHaveBeenCalledWith(tool);

    registry.unregister('customTool');
    expect(onUnregister).toHaveBeenCalledWith(tool);
  });
});

describe('RuntimeToolExecutor', () => {
  const mockDispatchEvent = vi.fn();
  const bridge = {
    applyReplacements: vi.fn(),
    startStreamingEdit: vi.fn(),
    streamContent: vi.fn(),
    endStreamingEdit: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockDispatchEvent.mockReset();
    Object.assign(bridge, {
      applyReplacements: vi.fn().mockResolvedValue({ success: true }),
      startStreamingEdit: vi.fn(),
      streamContent: vi.fn(),
      endStreamingEdit: vi.fn(),
    });

    class MockCustomEvent {
      type: string;
      detail: any;
      constructor(type: string, init?: { detail?: any }) {
        this.type = type;
        this.detail = init?.detail;
      }
    }

    (globalThis as any).aiChatBridge = bridge;
    (globalThis as any).window = {
      dispatchEvent: mockDispatchEvent,
    } as any;
    (globalThis as any).CustomEvent = MockCustomEvent;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).aiChatBridge;
    delete (globalThis as any).window;
    delete (globalThis as any).CustomEvent;
    vi.restoreAllMocks();
  });

  it('executes applyDiff via the editor bridge and emits lifecycle events', async () => {
    const registry = new ToolRegistry();
    const executor = new RuntimeToolExecutor(registry);
    const start = vi.fn();
    const complete = vi.fn();

    executor.on('execution:start', start);
    executor.on('execution:complete', complete);

    const replacements = [{ oldText: 'foo', newText: 'bar' }];
    const filePath = '/test/document.md';
    const result = await executor.execute('applyDiff', { replacements, filePath });

    expect(bridge.applyReplacements).toHaveBeenCalledWith(filePath, replacements);
    expect(result).toEqual({ success: true });
    expect(start).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);

    expect(mockDispatchEvent).toHaveBeenCalledTimes(1);
    const eventArg = mockDispatchEvent.mock.calls[0][0] as { detail: any };
    expect(eventArg.detail.name).toBe('applyDiff');
    expect(eventArg.detail.args).toEqual({ replacements, filePath });
  });

  it('executes streamContent via the editor bridge', async () => {
    const registry = new ToolRegistry();
    const executor = new RuntimeToolExecutor(registry);

    const output = await executor.execute('streamContent', {
      content: 'Hello world',
      position: 'end',
      mode: 'append',
    });

    expect(bridge.startStreamingEdit).toHaveBeenCalled();
    expect(bridge.streamContent).toHaveBeenCalledWith(expect.any(String), 'Hello world');
    expect(bridge.endStreamingEdit).toHaveBeenCalled();
    expect(output).toEqual({ success: true });
  });

  it('emits error event when tool execution fails', async () => {
    const registry = new ToolRegistry([]);
    registry.register({
      name: 'boom',
      description: 'throws',
      parameters: {
        type: 'object',
        properties: {},
      },
      handler: () => {
        throw new Error('boom');
      },
    });

    const executor = new RuntimeToolExecutor(registry);
    const errorListener = vi.fn();
    executor.on('execution:error', errorListener);

    await expect(executor.execute('boom', {})).rejects.toThrow('boom');
    expect(errorListener).toHaveBeenCalledTimes(1);
    const event = errorListener.mock.calls[0][0];
    expect(event.toolName).toBe('boom');
    expect(event.error).toBeInstanceOf(Error);
  });
});
