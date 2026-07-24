import { afterEach, describe, expect, it } from 'vitest';
import {
  executeExtensionTool,
  registerExtensionTools,
  setEnsureEditorCallback,
  unregisterExtensionTools,
} from '../ExtensionAIToolsBridge';
import { registerEditorAPI, unregisterEditorAPI } from '../ExtensionEditorAPIRegistry';
import type { LoadedExtension } from '../types';

function makeExtension(tools: LoadedExtension['module']['aiTools']): LoadedExtension {
  return {
    manifest: {
      id: 'com.test.fixture',
      name: 'Fixture',
      version: '0.0.0',
      main: 'index.js',
    },
    module: { aiTools: tools },
    context: {
      manifest: {
        id: 'com.test.fixture',
        name: 'Fixture',
        version: '0.0.0',
        main: 'index.js',
      },
      extensionPath: '/tmp/fixture',
      services: {} as LoadedExtension['context']['services'],
      subscriptions: [],
    },
    enabled: true,
    dispose: async () => {},
  };
}

describe('ExtensionAIToolsBridge access modes', () => {
  afterEach(() => {
    unregisterExtensionTools('com.test.fixture');
    unregisterEditorAPI('/workspace/doc.fixture');
    setEnsureEditorCallback(async () => {}, () => {});
  });

  it('does not mount or flush editors for filesystem tools with a filePath', async () => {
    let ensureCalls = 0;
    let releaseCalls = 0;
    let sawEditorAPI = false;

    setEnsureEditorCallback(
      async () => { ensureCalls++; },
      () => { releaseCalls++; }
    );

    registerExtensionTools(makeExtension([
      {
        name: 'read_disk',
        description: 'Read from disk',
        access: { kind: 'filesystem' },
        handler: async (_params, context) => {
          sawEditorAPI = context.editorAPI !== undefined;
          return { success: true };
        },
      },
    ]));

    const result = await executeExtensionTool(
      'fixture.read_disk',
      { filePath: '/workspace/doc.fixture' },
      { workspacePath: '/workspace', activeFilePath: '/workspace/doc.fixture' }
    );

    expect(result.success).toBe(true);
    expect(ensureCalls).toBe(0);
    expect(releaseCalls).toBe(0);
    expect(sawEditorAPI).toBe(false);
  });

  it('mounts editor-write tools and waits for the registered save callback', async () => {
    let ensureCalls = 0;
    let releaseCalls = 0;
    let saveCompleted = false;
    let sawEditorAPI = false;

    setEnsureEditorCallback(
      async (filePath) => {
        ensureCalls++;
        registerEditorAPI(filePath, { ready: true }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          saveCompleted = true;
        });
      },
      () => { releaseCalls++; }
    );

    registerExtensionTools(makeExtension([
      {
        name: 'write_editor',
        description: 'Write through editor',
        access: { kind: 'editor-write' },
        handler: async (_params, context) => {
          sawEditorAPI = context.editorAPI !== undefined;
          return { success: true };
        },
      },
    ]));

    const result = await executeExtensionTool(
      'fixture.write_editor',
      { filePath: '/workspace/doc.fixture' },
      { workspacePath: '/workspace', activeFilePath: '/workspace/doc.fixture' }
    );

    expect(result.success).toBe(true);
    expect(ensureCalls).toBe(1);
    expect(releaseCalls).toBe(1);
    expect(sawEditorAPI).toBe(true);
    expect(saveCompleted).toBe(true);
  });

  it('mounts editor-read tools but never flushes the editor', async () => {
    let ensureCalls = 0;
    let flushCalls = 0;
    let sawEditorAPI = false;

    setEnsureEditorCallback(
      async (filePath) => {
        ensureCalls++;
        registerEditorAPI(filePath, { ready: true }, async () => { flushCalls++; });
      },
      () => {}
    );

    registerExtensionTools(makeExtension([
      {
        name: 'read_editor',
        description: 'Inspect editor state without mutating it',
        access: { kind: 'editor-read' },
        handler: async (_params, context) => {
          sawEditorAPI = context.editorAPI !== undefined;
          return { success: true };
        },
      },
    ]));

    const result = await executeExtensionTool(
      'fixture.read_editor',
      { filePath: '/workspace/doc.fixture' },
      { workspacePath: '/workspace', activeFilePath: '/workspace/doc.fixture' }
    );

    expect(result.success).toBe(true);
    expect(ensureCalls).toBe(1);
    expect(sawEditorAPI).toBe(true);
    expect(flushCalls).toBe(0);
  });

  it('legacy readOnly tools map to editor-read (mount, no flush)', async () => {
    let flushCalls = 0;

    setEnsureEditorCallback(
      async (filePath) => {
        registerEditorAPI(filePath, { ready: true }, async () => { flushCalls++; });
      },
      () => {}
    );

    registerExtensionTools(makeExtension([
      {
        name: 'legacy_read',
        description: 'Legacy read-only tool',
        readOnly: true,
        handler: async () => ({ success: true }),
      },
    ]));

    const result = await executeExtensionTool(
      'fixture.legacy_read',
      { filePath: '/workspace/doc.fixture' },
      { workspacePath: '/workspace', activeFilePath: '/workspace/doc.fixture' }
    );

    expect(result.success).toBe(true);
    expect(flushCalls).toBe(0);
  });

  it('an undeclared tool still routes through the conflict-aware flush (compat default)', async () => {
    // The untrusted-developer guarantee: a tool that forgets to declare `access`
    // must not lose its writes (so legacy write tools keep working) AND its only
    // path to disk is the host's flush callback -- which is conflict-aware and
    // refuses to clobber an out-of-band write. Here we assert the routing: the
    // default mounts an editor and invokes the (single, host-owned) flush.
    let flushCalls = 0;

    setEnsureEditorCallback(
      async (filePath) => {
        registerEditorAPI(filePath, { ready: true }, async () => { flushCalls++; });
      },
      () => {}
    );

    registerExtensionTools(makeExtension([
      {
        name: 'undeclared',
        description: 'Tool with no access mode declared',
        handler: async () => ({ success: true }),
      },
    ]));

    const result = await executeExtensionTool(
      'fixture.undeclared',
      { filePath: '/workspace/doc.fixture' },
      { workspacePath: '/workspace', activeFilePath: '/workspace/doc.fixture' }
    );

    expect(result.success).toBe(true);
    expect(flushCalls).toBe(1);
  });
});
