import { describe, it, expect } from 'vitest';
import { getDevAgentOpenAITools } from '../devAgentTools';

describe('getDevAgentOpenAITools scope filtering', () => {
  it("'read' returns only read_file, list_files, search_files", () => {
    const tools = getDevAgentOpenAITools('read');
    const names = tools.map((t) => t.function.name);
    expect(new Set(names)).toEqual(new Set(['read_file', 'list_files', 'search_files']));
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('run_command');
  });

  it("'write' returns read tools and write_file but not run_command", () => {
    const tools = getDevAgentOpenAITools('write');
    const names = tools.map((t) => t.function.name);
    expect(names).toContain('read_file');
    expect(names).toContain('list_files');
    expect(names).toContain('search_files');
    expect(names).toContain('write_file');
    expect(names).not.toContain('run_command');
  });

  it("'full' returns all five tools including run_command", () => {
    const tools = getDevAgentOpenAITools('full');
    const names = tools.map((t) => t.function.name);
    expect(new Set(names)).toEqual(
      new Set(['read_file', 'list_files', 'search_files', 'write_file', 'run_command']),
    );
  });

  it('defaults to full scope and includes run_command', () => {
    const tools = getDevAgentOpenAITools();
    const names = tools.map((t) => t.function.name);
    expect(names).toContain('run_command');
  });
});
