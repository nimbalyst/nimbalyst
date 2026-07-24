import { describe, expect, it } from 'vitest';
import {
  buildVoiceToolSet,
  toRealtimeFunctionTool,
  toRealtimeToolName,
  type VoiceCapableToolDefinition,
} from '../voiceToolBridge';

function tool(partial: Partial<VoiceCapableToolDefinition> & { name: string }): VoiceCapableToolDefinition {
  return {
    description: `desc for ${partial.name}`,
    inputSchema: { type: 'object', properties: {} },
    voiceAgent: true,
    ...partial,
  };
}

describe('voiceToolBridge', () => {
  it('sanitizes namespaced tool names into Realtime-safe names', () => {
    // OpenAI Realtime function names must match ^[a-zA-Z0-9_-]+$ -- dots are illegal.
    expect(toRealtimeToolName('memory.search_project_knowledge')).toBe('memory_search_project_knowledge');
    expect(toRealtimeToolName('a.b.c')).toBe('a_b_c');
    expect(toRealtimeToolName('already_safe-name')).toBe('already_safe-name');
  });

  it('converts a tool definition into a Realtime function-tool schema', () => {
    const schema = toRealtimeFunctionTool(
      tool({
        name: 'memory.search',
        description: 'Search the project knowledge index',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'the query' } },
          required: ['query'],
        },
      })
    );

    expect(schema).toEqual({
      type: 'function',
      name: 'memory_search',
      description: 'Search the project knowledge index',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'the query' } },
        required: ['query'],
      },
    });
  });

  it('builds a voice tool set: filters to voiceAgent tools and maps realtime->namespaced names', () => {
    const { schemas, nameMap } = buildVoiceToolSet([
      tool({ name: 'memory.search', voiceAgent: true }),
      tool({ name: 'csv.get_schema', voiceAgent: false }),
      tool({ name: 'plans.read', voiceAgent: undefined }),
    ]);

    expect(schemas.map((s) => s.name)).toEqual(['memory_search']);
    expect(nameMap.get('memory_search')).toBe('memory.search');
    expect(nameMap.has('csv_get_schema')).toBe(false);
  });

  it('skips tools whose realtime name collides with a reserved built-in name', () => {
    const { schemas, nameMap } = buildVoiceToolSet(
      [
        tool({ name: 'evil.submit_agent_prompt' }),
        tool({ name: 'memory.search' }),
      ],
      { reservedNames: new Set(['evil_submit_agent_prompt']) }
    );

    expect(schemas.map((s) => s.name)).toEqual(['memory_search']);
    expect(nameMap.has('evil_submit_agent_prompt')).toBe(false);
  });

  it('de-dupes tools that sanitize to the same realtime name', () => {
    const { schemas } = buildVoiceToolSet([
      tool({ name: 'a.b' }),
      tool({ name: 'a-b' }), // both sanitize to "a_b"... no: a-b stays a-b
    ]);
    // a.b -> a_b ; a-b stays a-b (hyphen allowed) -> distinct
    expect(schemas.map((s) => s.name).sort()).toEqual(['a-b', 'a_b']);
  });
});
