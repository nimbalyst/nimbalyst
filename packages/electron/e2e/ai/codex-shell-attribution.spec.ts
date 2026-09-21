import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchElectronApp, waitForAppReady } from '../helpers';
import { dismissAPIKeyDialog } from '../utils/testHelpers';
test.skip(() => !process.env.RUN_REAL_CODEX, 'Requires Codex CLI auth + RUN_REAL_CODEX=1');
test.setTimeout(480_000);
test('production Codex shell hooks resolve overlapping and sequential owners after a failed MCP lookup', async ({}, testInfo) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-shell-implementation-')),
    workspace = path.join(root, 'workspace'),
    database = path.join(root, 'database'),
    userData = path.join(root, 'user-data'),
    codexHome = path.join(root, 'codex-home');
  for (const dir of [workspace, database, userData, codexHome]) await fs.mkdir(dir, { mode: 0o700 });
  await fs.writeFile(path.join(userData, 'logger-config.json'), JSON.stringify({ loggerConfig: {
    globalLevel: 'debug', fileLogging: true, consoleLogging: true, components: { MAIN: { enabled: true, level: 'debug' } },
  } }));
  await fs.copyFile(
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'),
    path.join(codexHome, 'auth.json')
  );
  await fs.chmod(path.join(codexHome, 'auth.json'), 0o600);
  await fs.writeFile(path.join(workspace, 'shared.ts'), '// baseline\n');
  await fs.writeFile(path.join(workspace, 'readonly.ts'), '// unchanged\n');
  await fs.writeFile(path.join(workspace, 'after-failure.ts'), '// baseline\n');
  await fs.writeFile(path.join(workspace, 'overlap-writer.ts'), '// baseline\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Tracking Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  expect(await fs.realpath(git('rev-parse', '--show-toplevel').trim())).toBe(await fs.realpath(workspace));
  await fs.mkdir(path.join(workspace, '.claude'));
  for (let i = 0; i < 7500; i += 64) await Promise.all(Array.from({ length: Math.min(64, 7500 - i) }, (_, j) =>
    fs.writeFile(path.join(workspace, '.claude', `command-${i + j}.md`), 'checkout baseline\n')));
  await fs.writeFile(path.join(workspace, 'rebuild.cjs'), `const fs = require('fs'); fs.rmSync('types', {recursive: true, force: true}); fs.mkdirSync('types'); for (let i=0;i<300;i++) fs.writeFileSync('types/generated-'+i+'.d.ts', 'export declare const value: string;\\n');`);
  execFileSync(process.execPath, ['rebuild.cjs'], { cwd: workspace });
  git('add', '.');
  git('commit', '-qm', 'Fixture baseline');
  let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  const evidence: any = { root, owners: [], hookLog: [] };
  try {
    // Set isolation before the bundle evaluates static imports that create stores.
    // The normal bootstrap sets userData later; logger configuration is read earlier.
    const mainPath = process.env.NIMBALYST_E2E_MAIN_PATH ?? path.resolve(__dirname, '../../out/main/index.js');
    const entry = path.join(root, 'isolated-main.cjs');
    await fs.writeFile(entry, `const { app } = require('electron');\napp.setPath('userData', ${JSON.stringify(userData)});\napp.setAppPath(${JSON.stringify(path.dirname(mainPath))});\nrequire(${JSON.stringify(mainPath)});\n`);
    evidence.mainPath = mainPath;
    const launchOptions = {
      mainPath: entry,
      workspace,
      preserveTestDatabase: true,
      // This disposable fixture creates Git worktrees; workspace-write protects .git.
      permissionMode: 'none' as const,
      recordVideo: { dir: path.join(testInfo.outputDir, 'video') },
      env: {
        NIMBALYST_PERMISSION_MODE: 'bypass-all',
        NIMBALYST_USER_DATA_PATH: database,
        NIMBALYST_USER_DATA_DIR: userData,
        NIMBALYST_CDP_PORT: '0',
        NIMBALYST_SHELL_HOOK_TRACE: '1',
        CODEX_HOME: codexHome,
      },
    };
    app = await launchElectronApp(launchOptions);
    // autoUpdater resets the file transport to info. Capture the debug console
    // transport directly so absent file-log entries cannot imply absent hooks.
    for (const stream of [app.process().stdout, app.process().stderr]) {
      let pending = '';
      stream?.on('data', chunk => {
        const lines = (pending + String(chunk)).split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const marker = '[CodexShellTracking] Hook ';
          const offset = line.indexOf(marker);
          if (offset < 0) continue;
          const json = line.slice(offset + marker.length).replace(/\u001b\[[0-9;]*m/g, '');
          try { evidence.hookLog.push(JSON.parse(json)); } catch { /* Other console output is not evidence. */ }
        }
      });
    }
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await waitForAppReady(page);
    await dismissAPIKeyDialog(page);
    evidence.isolation = await app.evaluate(({ app }) => ({
      userData: app.getPath('userData'),
      database: process.env.NIMBALYST_USER_DATA_PATH,
    }));
    expect(evidence.isolation).toEqual({ userData, database });
    const logPath = path.join(userData, 'logs', 'main.log');
    const recordTurn = async (id: string) => {
      const captured = await page.evaluate(async ({ id, workspace }) => {
        const api = (window as any).electronAPI;
        const context = await api.invoke('git:get-commit-context', workspace, id);
        const raw = await api.invoke('test:query-db', 'SELECT content FROM ai_agent_messages WHERE session_id=$1 AND direction=$2 ORDER BY id', [id, 'output']);
        const durable = await api.invoke('test:query-db', 'SELECT data FROM shell_tracking_coverage WHERE session_id=$1', [id]);
        return { sessionId: id, coverage: context.coverage, raw, durable };
      }, { id, workspace });
      const hooks = evidence.hookLog.filter((hook: any) => hook.sessionId === id);
      return { ...captured, hooks };
    };
    const assertDiagnostics = (captured: Awaited<ReturnType<typeof recordTurn>>) => {
      for (const summary of captured.coverage) for (const event of summary.events ?? []) {
        if (!['unmatchedTool', 'missingPre', 'staleEvent', 'foreignTool'].includes(event.reason)) continue;
        expect(event.tool).toEqual(expect.any(String));
        if (event.hookTurnId !== undefined) expect(event.turnMatched).toEqual(expect.any(Boolean));
        if (event.agentType !== undefined) expect(event.agentType).toEqual(expect.any(String));
      }
    };
    await page.evaluate(async () => {
      await (window as any).electronAPI.invoke('ai:saveSettings', {
        providerSettings: { 'openai-codex': { enabled: true } },
      });
      (window as any).__fileLinkEvents = [];
      (window as any).electronAPI.on('session-files:updated', (...args: any[]) =>
        (window as any).__fileLinkEvents.push(args)
      );
    });
    await expect.poll(async () => page.evaluate(async () =>
      (await (window as any).electronAPI.invoke('openai-codex:check-login')).isLoggedIn
    ), { timeout: 15_000, message: 'Isolated Codex auth must be ready before exercising tracking' }).toBe(true);
    // An external readiness marker proves the sleeper passed its acknowledged
    // pre-hook before starting the writer. It is outside the watched workspace.
    const readyPath = path.join(root, 'overlap-ready');
    const overlap = await page.evaluate(async ({ workspace, readyPath }) => {
      const api = (window as any).electronAPI;
      const sleeper = await api.invoke('ai:createSession', 'openai-codex', undefined, workspace, 'openai-codex:gpt-6-astra', 'agent');
      const writer = await api.invoke('ai:createSession', 'openai-codex', undefined, workspace, 'openai-codex:gpt-6-astra', 'agent');
      (window as any).__overlapSleeper = api.invoke('ai:sendMessage',
        `This is an isolated tracking fixture. Execute exactly one normal shell command: printf ready > '${readyPath}'; sleep 45; touch ./overlap-sleep.ts . Wait for it to finish, then say DONE. Do not use patches, MCP, subagents, or any other command.`,
        undefined, sleeper.id, workspace);
      return { sleeper: sleeper.id, writer: writer.id };
    }, { workspace, readyPath });
    evidence.overlap = overlap;
    await expect.poll(() => fs.readFile(readyPath, 'utf8').catch(() => ''), { timeout: 60_000 }).toBe('ready');
    evidence.overlapWriterResult = await page.evaluate(async ({ workspace, id }) =>
      (window as any).electronAPI.invoke('ai:sendMessage',
        "This is an isolated tracking fixture. Execute exactly one normal shell command: printf '// overlap writer\\n' > ./overlap-writer.ts . Then say DONE. Do not use patches, MCP, subagents, or any other command.",
        undefined, id, workspace), { workspace, id: overlap.writer });
    expect(evidence.overlapWriterResult.content).toContain('DONE');
    evidence.overlapSleeperResult = await page.evaluate(() => (window as any).__overlapSleeper);
    expect(evidence.overlapSleeperResult.content).toContain('DONE');
    evidence.overlapTurns = [await recordTurn(overlap.sleeper), await recordTurn(overlap.writer)];
    const overlapHooks = evidence.hookLog.filter((hook: any) =>
      [overlap.sleeper, overlap.writer].includes(hook.sessionId) && hook.tool === 'Bash');
    evidence.overlapHooks = overlapHooks;
    expect(overlapHooks.map((hook: any) => [hook.sessionId, hook.event])).toEqual([
      [overlap.sleeper, 'PreToolUse'], [overlap.writer, 'PreToolUse'],
      [overlap.writer, 'PostToolUse'], [overlap.sleeper, 'PostToolUse'],
    ]);
    expect(await fs.readFile(path.join(workspace, 'overlap-writer.ts'), 'utf8')).toBe('// overlap writer\n');
    evidence.overlapWriterLinks = await page.evaluate(async ({ workspace, filePath }) =>
      (window as any).electronAPI.invoke('sessions:get-by-file', workspace, filePath),
      { workspace, filePath: path.join(workspace, 'overlap-writer.ts') });
    expect(evidence.overlapWriterLinks.map((owner: any) => owner.id)).toEqual([overlap.writer]);
    for (const turn of evidence.overlapTurns) {
      expect(turn.coverage).toEqual([expect.objectContaining({ sessionId: turn.sessionId, state: 'no-detected-fault' })]);
      expect(JSON.parse(turn.durable.rows[0].data).pendingTools).toEqual({});
    }
    for (const marker of ['first', 'second']) {
      const session = await page.evaluate(
        async ({ workspace }) =>
          (window as any).electronAPI.invoke(
            'ai:createSession',
            'openai-codex',
            undefined,
            workspace,
            'openai-codex:gpt-6-astra',
            'agent'
          ),
        { workspace }
      );
      expect(session.id).toBeTruthy();
      evidence.owners.push(session.id);
      const checkoutStep = marker === 'first' ? 'First run `node rebuild.cjs` to delete and regenerate identical tracked declarations. Then create the fixture worktree by running `git worktree add --detach scratch-checkout HEAD`. If this fails, stop and report its full error. Then run `printf \'// authored\\n\' > scratch-checkout/shared.ts`. This checkout is a required part of the test. ' : '';
      const result = await page.evaluate(
        async ({ workspace, id, marker, checkoutStep }) =>
          (window as any).electronAPI.invoke(
            'ai:sendMessage',
            `This is an isolated file tracking acceptance fixture. ${checkoutStep}In strict sequence in this single turn: 1. Use your normal shell tool to execute exactly: printf '// ${marker}\\n' > shared.ts; cat readonly.ts; 2. Call the nimbalyst-trackers tracker_get MCP tool with id "shell-attribution-fixture-missing-item" exactly once. The item does not exist; its error is expected. 3. Continue despite that error and execute: printf '// ${marker}\\n' > after-failure.ts; Do not apply a patch, inspect other files, commit, retry the lookup, or change anything else. End with DONE.`,
            undefined,
            id,
            workspace
          ),
        { workspace, id: session.id, marker, checkoutStep }
      );
      evidence[marker] = result;
      evidence[marker + 'Raw'] = await page.evaluate(async id =>
        (window as any).electronAPI.invoke('test:query-db', 'SELECT content FROM ai_agent_messages WHERE session_id=$1 AND direction=$2 ORDER BY id', [id, 'output']), session.id);
      expect(result.content, 'Codex must finish the fixture commands before file assertions').toContain('DONE');
      if (marker === 'first') expect(await fs.readFile(path.join(workspace, 'scratch-checkout', 'shared.ts'), 'utf8')).toBe('// authored\n');
      await expect
        .poll(() => fs.readFile(path.join(workspace, 'shared.ts'), 'utf8'), { timeout: 60_000 })
        .toBe(`// ${marker}\n`);
      const links = await page.evaluate(
        async ({ workspace, filePath }) =>
          (window as any).electronAPI.invoke('sessions:get-by-file', workspace, filePath),
        { workspace, filePath: path.join(workspace, 'shared.ts') }
      );
      evidence[marker + 'Links'] = links;
      expect(links.map((x: any) => x.id).sort()).toEqual([...evidence.owners].sort());
      expect(links.every((x: any) => x.fileAttribution === 'inferred' && x.lastFileEditAt > 0)).toBe(true);
      expect(await fs.readFile(path.join(workspace, 'after-failure.ts'), 'utf8')).toBe(`// ${marker}\n`);
      const afterFailure = await page.evaluate(
        async ({ workspace, id, filePath }) => {
          const result = await (window as any).electronAPI.invoke(
            'test:query-db', 'SELECT content FROM ai_agent_messages WHERE session_id = $1 AND direction = $2', [id, 'output']
          );
          const failedLookup = result.rows.some((row: any) => {
            try {
              const item = JSON.parse(row.content)?.params?.item;
              return item?.type === 'mcpToolCall' && item.tool === 'tracker_get' && item.status === 'failed';
            } catch { return false; }
          });
          const links = await (window as any).electronAPI.invoke('sessions:get-by-file', workspace, filePath);
          return { failedLookup, owners: links.map((x: any) => x.id).sort() };
        },
        { workspace, id: session.id, filePath: path.join(workspace, 'after-failure.ts') }
      );
      const commitContext = await page.evaluate(async ({ workspace, id }) =>
        (window as any).electronAPI.invoke('git:get-commit-context', workspace, id), { workspace, id: session.id });
      evidence[marker + 'Coverage'] = commitContext.coverage;
      expect(commitContext.coverage).toEqual([expect.objectContaining({ sessionId: session.id, state: 'no-detected-fault' })]);
      const durableCoverage = await page.evaluate(async id =>
        (window as any).electronAPI.invoke('test:query-db', 'SELECT data FROM shell_tracking_coverage WHERE session_id = $1', [id]), session.id);
      expect(JSON.parse(durableCoverage.rows[0].data).active).toEqual([]);
      expect(JSON.parse(durableCoverage.rows[0].data).pendingTools).toEqual({});
      evidence[marker + 'AfterFailure'] = afterFailure;
      expect(afterFailure).toEqual({ failedLookup: true, owners: [...evidence.owners].sort() });
    }
    expect(await fs.readFile(path.join(workspace, 'scratch-checkout', 'shared.ts'), 'utf8')).toBe('// authored\n');
    const checkoutLinks = await page.evaluate(async ({ workspace }) => {
      const api = (window as any).electronAPI;
      return {
        copied: await api.invoke('sessions:get-by-file', workspace, workspace + '/scratch-checkout/.claude/command-0.md'),
        edited: await api.invoke('sessions:get-by-file', workspace, workspace + '/scratch-checkout/shared.ts'),
      };
    }, { workspace });
    expect(checkoutLinks.copied).toEqual([]);
    expect(checkoutLinks.edited.map((s: any) => s.id)).toEqual([evidence.owners[0]]);
    evidence.checkoutLinks = checkoutLinks;
    const readLinks = await page.evaluate(
      async ({ workspace, filePath }) =>
        (window as any).electronAPI.invoke('sessions:get-by-file', workspace, filePath),
      { workspace, filePath: path.join(workspace, 'readonly.ts') }
    );
    expect(readLinks).toEqual([]);
    evidence.rows = await page.evaluate(
      async ({ workspace }) =>
        (window as any).electronAPI.invoke(
          'test:query-db',
          'SELECT session_id, file_path, link_type, metadata FROM session_files WHERE workspace_id = $1',
          [workspace]
        ),
      { workspace }
    );
    expect(evidence.rows.rows.filter((row: any) => row.file_path.includes('/scratch-checkout/.claude/'))).toEqual([]);
    expect(evidence.rows.rows.filter((row: any) => row.file_path.includes('/types/generated-'))).toEqual([]);
    expect(git('diff', '--name-only', 'HEAD', '--', 'types')).toBe('');
    evidence.notifications = await page.evaluate(() => (window as any).__fileLinkEvents);
    expect(evidence.notifications.length).toBeGreaterThan(0);
    expect(evidence.hookLog.some((hook: any) => hook.tool === 'Bash'), 'Debug capture must observe the baseline shell hooks').toBe(true);
    // Questions are non-writers; native subagent hooks must be fenced at the root host.
    const questionPrompt = `Call the nimbalyst AskUserQuestion MCP tool exactly once with this exact argument object: ${JSON.stringify({ questions: [{ header: 'Fixture', question: 'Proceed with the fixture?', options: [{ label: 'Yes', description: 'Proceed with the fixture.' }, { label: 'No', description: 'Do not proceed with the fixture.' }], multiSelect: false }] })}. Wait for the answer. Do not run shell commands or other tools.`;
    const questionId = await page.evaluate(async ({ workspace, questionPrompt }) => {
      const api = (window as any).electronAPI;
      const session = await api.invoke('ai:createSession', 'openai-codex', undefined, workspace, 'openai-codex:gpt-6-astra', 'agent');
      (window as any).__sliceQuestion = api.invoke('ai:sendMessage', questionPrompt + ' After the answer, end with DONE.', undefined, session.id, workspace);
      return session.id;
    }, { workspace, questionPrompt });
    let promptId = '';
    evidence.questionSession = questionId;
    await expect.poll(async () => {
      const waiting = (await fs.readFile(logPath, 'utf8')).split('\n').find(line =>
        line.includes('AskUserQuestion waiting for response: questionId=') && line.includes(`sessionId=${questionId}`));
      promptId = waiting?.split('questionId=')[1]?.split(', sessionId=')[0] ?? '';
      return !!promptId;
    }, { timeout: 60_000 }).toBe(true);
    const answer = await page.evaluate(async ({ id, promptId }) => (window as any).electronAPI.invoke('messages:respond-to-prompt', {
      sessionId: id, promptId, promptType: 'ask_user_question_request', response: { answers: { 'Proceed with the fixture?': 'Yes' } }, respondedBy: 'desktop',
    }), { id: questionId, promptId });
    expect(answer.success).toBe(true);
    evidence.questionResult = await page.evaluate(() => (window as any).__sliceQuestion);
    evidence.questionTurn = await recordTurn(questionId);
    expect(evidence.questionResult.content).toContain('DONE');
    assertDiagnostics(evidence.questionTurn);
    expect(evidence.questionTurn.coverage).toEqual([expect.objectContaining({ sessionId: questionId, state: 'no-detected-fault' })]);
    expect(evidence.questionTurn.coverage[0].reasons.unmatchedTool ?? 0).toBe(0);
    const subagentId = await page.evaluate(async ({ workspace }) => {
      const api = (window as any).electronAPI;
      const session = await api.invoke('ai:createSession', 'openai-codex', undefined, workspace, 'openai-codex:gpt-6-astra', 'agent');
      return session.id;
    }, { workspace });
    evidence.subagentSession = subagentId;
    evidence.subagentResult = await page.evaluate(async ({ id, workspace }) => (window as any).electronAPI.invoke('ai:sendMessage',
      `Use Codex's native spawn_agent tool (not Nimbalyst spawn_session) to create exactly one worker. Tell the worker to run exactly this shell command in ${workspace}: printf '// subagent\\n' > subagent.ts . The worker must use its shell tool and then finish. Wait for the worker to finish, close it, and end with DONE. The parent must not execute any shell command, patch, or write itself. Do not commit or change any other file.`,
      undefined, id, workspace), { id: subagentId, workspace });
    evidence.subagentTurn = await recordTurn(subagentId);
    expect(evidence.subagentResult.content).toContain('DONE');
    expect(await fs.readFile(path.join(workspace, 'subagent.ts'), 'utf8')).toBe('// subagent\n');
    for (const kind of ['started', 'completed']) expect(evidence.subagentTurn.raw.rows.some((row: any) => {
      try { const item = JSON.parse(row.content)?.params?.item; return item?.type === 'subAgentActivity' && item.kind === kind && item.agentThreadId; } catch { return false; }
    }), `The fixture must observe a native Codex subagent ${kind}`).toBe(true);
    assertDiagnostics(evidence.subagentTurn);
    evidence.subagentLinks = await page.evaluate(async ({ workspace, filePath }) =>
      (window as any).electronAPI.invoke('sessions:get-by-file', workspace, filePath),
    { workspace, filePath: path.join(workspace, 'subagent.ts') });
    expect(evidence.subagentLinks.map((session: any) => session.id)).not.toContain(subagentId);
    expect(evidence.subagentTurn.coverage).toEqual([expect.objectContaining({ sessionId: subagentId, state: 'no-detected-fault' })]);
    expect(evidence.subagentTurn.coverage[0].reasons.foreignTool ?? 0).toBeGreaterThanOrEqual(1);
    // A waiting, acknowledged MCP call keeps the turn active without an unfinished shell write.
    const waitingId = await page.evaluate(async ({ workspace, questionPrompt }) => {
      const api = (window as any).electronAPI;
      const session = await api.invoke('ai:createSession', 'openai-codex', undefined, workspace, 'openai-codex:gpt-6-astra', 'agent');
      void api.invoke('ai:sendMessage', questionPrompt, undefined, session.id, workspace).catch(() => {});
      return session.id;
    }, { workspace, questionPrompt });
    await expect.poll(async () => page.evaluate(async id => {
      const result = await (window as any).electronAPI.invoke('test:query-db', 'SELECT content FROM ai_agent_messages WHERE session_id = $1 AND direction = $2', [id, 'output']);
      return result.rows.some((row: any) => { try { const value = JSON.parse(row.content); return value.method === 'item/started' && value.params?.item?.tool === 'AskUserQuestion'; } catch { return false; } });
    }, waitingId), { timeout: 60_000 }).toBe(true);
    await expect.poll(async () => page.evaluate(async id => {
      const result = await (window as any).electronAPI.invoke('test:query-db', 'SELECT data FROM shell_tracking_coverage WHERE session_id = $1', [id]);
      return result.rows[0] ? JSON.parse(result.rows[0].data).pendingTools : null;
    }, waitingId)).toEqual({});
    evidence.waitingSession = waitingId;
    evidence.waitingQuestionTurn = await recordTurn(waitingId);
    await app.close();
    app = await launchElectronApp(launchOptions);
    const restartedPage = await app.firstWindow();
    await restartedPage.waitForLoadState('domcontentloaded');
    // A restored Agent view can keep the file sidebar hidden. Readiness here is
    // the coverage IPC, independent of which workspace mode was restored.
    const readRestored = () => restartedPage.evaluate(async id => (window as any).electronAPI.invoke('session-files:coverage', [id]), waitingId);
    await expect.poll(readRestored, { timeout: 15_000 }).toEqual([expect.objectContaining({ sessionId: waitingId, state: 'no-detected-fault', reasons: {} })]);
    const restored = await readRestored();
    evidence.afterRestart = restored;
    expect(restored).toEqual([expect.objectContaining({ sessionId: waitingId, state: 'no-detected-fault', reasons: {} })]);

  } finally {
    await app?.close();
    await fs.rm(codexHome, { recursive: true, force: true });
    await fs.writeFile(testInfo.outputPath('app-evidence.json'), JSON.stringify(evidence, null, 2));
    await testInfo.attach('evidence', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'application/json',
    });
  }
});
