import { afterEach, describe, expect, it, vi } from 'vitest';
import { activate, aiTools } from '../index';
import { parseAutomationStatus } from '../frontmatter/parser';

function automationFile(): string {
  return `---
automationStatus:
  id: codex-scout
  title: Codex Scout
  enabled: true
  schedule:
    type: daily
    time: "09:00"
  output:
    mode: new-file
    location: nimbalyst-local/automations/codex-scout/
    fileNameTemplate: "{{date}}-output.md"
  provider: openai-codex
  model: openai-codex:gpt-5.6-sol
  runCount: 0
---

Run the scout.
`;
}

describe('automation execution', () => {
  const disposables: Array<{ dispose: () => void }> = [];

  afterEach(() => {
    for (const disposable of disposables.splice(0)) disposable.dispose();
    vi.restoreAllMocks();
  });

  it('records a Codex prompt rejection as an error while preserving the failure output', async () => {
    const path = 'nimbalyst-local/automations/codex-scout.md';
    const files = new Map([[path, automationFile()]]);
    const sendPrompt = vi.fn().mockRejectedValue(
      new Error('API key not configured for provider openai-codex.'),
    );
    const ui = { showInfo: vi.fn(), showWarning: vi.fn(), showError: vi.fn() };
    const filesystem = {
      readFile: async (filePath: string) => {
        const content = files.get(filePath);
        if (content === undefined) throw new Error(`ENOENT: ${filePath}`);
        return content;
      },
      writeFile: async (filePath: string, content: string) => {
        files.set(filePath, content);
      },
      fileExists: async (filePath: string) => files.has(filePath),
      findFiles: async () => [path],
    };

    await activate({ services: { filesystem, ui, ai: { sendPrompt } }, subscriptions: disposables });

    const runTool = aiTools.find((tool) => tool.name === 'automations.run');
    expect(runTool).toBeDefined();
    const result = await runTool!.handler({ id: 'codex-scout' }, {} as never);

    expect(sendPrompt).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai-codex',
      model: 'openai-codex:gpt-5.6-sol',
    }));
    expect(result).toEqual({
      success: false,
      error: 'API key not configured for provider openai-codex.',
    });

    const status = parseAutomationStatus(files.get(path)!);
    expect(status).toEqual(expect.objectContaining({
      lastRunStatus: 'error',
      lastRunError: 'API key not configured for provider openai-codex.',
      runCount: 0,
    }));

    const history = JSON.parse(files.get('nimbalyst-local/automations/codex-scout/history.json')!);
    expect(history).toEqual([
      expect.objectContaining({
        status: 'error',
        error: 'API key not configured for provider openai-codex.',
      }),
    ]);

    const output = [...files.entries()].find(([filePath]) => filePath.endsWith('-output.md'))?.[1];
    expect(output).toContain('API key not configured for provider openai-codex.');
    expect(ui.showError).toHaveBeenCalledWith(
      'Automation "Codex Scout" failed: API key not configured for provider openai-codex.',
    );
  });
});
