import { describe, expect, it } from 'vitest';
import { META_AGENT_TOOL_DEFS } from '../metaAgentServer';

describe('meta-agent Ollama Claude Code backend schema', () => {
  for (const toolName of ['create_session', 'spawn_session']) {
    it(`exposes the exact backend profile on ${toolName}`, () => {
      const tool = META_AGENT_TOOL_DEFS.find((candidate) => candidate.name === toolName);
      const property = tool?.inputSchema.properties.claudeCodeBackend as {
        type?: string;
        enum?: string[];
      } | undefined;

      expect(property).toEqual(
        expect.objectContaining({
          type: 'string',
          enum: ['ollama-glm-5-2-cloud'],
        })
      );
    });
  }
});
