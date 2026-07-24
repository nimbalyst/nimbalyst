import type { ToolDefinition } from './index';

export const PLAN_STATUS_TOOL: ToolDefinition = {
  name: 'updatePlanStatus',
  description: 'Update the plan status in a markdown document. Use applyDiff to replace the entire frontmatter block with the updated status.',
  parameters: {
    type: 'object',
    properties: {
      oldFrontmatter: {
        type: 'string',
        description: 'The complete current frontmatter block (including --- delimiters)',
      },
      newFrontmatter: {
        type: 'string',
        description: 'The complete updated frontmatter block with new status (including --- delimiters)',
      },
    },
    required: ['oldFrontmatter', 'newFrontmatter'],
  },
  source: 'runtime',
};