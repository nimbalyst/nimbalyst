import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchElectronApp, waitForAppReady } from '../helpers';
import { dismissAPIKeyDialog } from '../utils/testHelpers';
test.skip(() => !process.env.RUN_REAL_CODEX, 'Requires Codex CLI auth + RUN_REAL_CODEX=1');
test.setTimeout(240_000);
test('production Codex shell hooks persist sequential owners in an isolated app', async ({}, testInfo) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-shell-implementation-')),
    workspace = path.join(root, 'workspace'),
    database = path.join(root, 'database'),
    userData = path.join(root, 'user-data'),
    codexHome = path.join(root, 'codex-home');
  for (const dir of [workspace, database, userData, codexHome]) await fs.mkdir(dir, { mode: 0o700 });
  await fs.copyFile(
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'),
    path.join(codexHome, 'auth.json')
  );
  await fs.chmod(path.join(codexHome, 'auth.json'), 0o600);
  await fs.writeFile(path.join(workspace, 'shared.ts'), '// baseline\n');
  await fs.writeFile(path.join(workspace, 'readonly.ts'), '// unchanged\n');
  let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  const evidence: any = { root, owners: [] };
  try {
    app = await launchElectronApp({
      mainPath: process.env.NIMBALYST_E2E_MAIN_PATH,
      workspace,
      preserveTestDatabase: true,
      recordVideo: { dir: path.join(testInfo.outputDir, 'video') },
      env: {
        NIMBALYST_USER_DATA_PATH: database,
        NIMBALYST_USER_DATA_DIR: userData,
        NIMBALYST_CDP_PORT: '0',
        CODEX_HOME: codexHome,
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await waitForAppReady(page);
    await dismissAPIKeyDialog(page);
    evidence.isolation = await app.evaluate(({ app }) => ({
      userData: app.getPath('userData'),
      database: process.env.NIMBALYST_USER_DATA_PATH,
    }));
    expect(evidence.isolation).toEqual({ userData, database });
    await page.evaluate(async () => {
      await (window as any).electronAPI.invoke('ai:saveSettings', {
        providerSettings: { 'openai-codex': { enabled: true } },
      });
      (window as any).__fileLinkEvents = [];
      (window as any).electronAPI.on('session-files:updated', (...args: any[]) =>
        (window as any).__fileLinkEvents.push(args)
      );
    });
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
      const result = await page.evaluate(
        async ({ workspace, id, marker }) =>
          (window as any).electronAPI.invoke(
            'ai:sendMessage',
            `This is an isolated file tracking acceptance fixture. Use your normal shell tool to execute exactly: printf '// ${marker}\\n' > shared.ts; cat readonly.ts; Do not apply a patch, inspect other files, commit, or change anything else. End with DONE.`,
            undefined,
            id,
            workspace
          ),
        { workspace, id: session.id, marker }
      );
      evidence[marker] = result;
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
    }
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
    evidence.notifications = await page.evaluate(() => (window as any).__fileLinkEvents);
    expect(evidence.notifications.length).toBeGreaterThan(0);
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
