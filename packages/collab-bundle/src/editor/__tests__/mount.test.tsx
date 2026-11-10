import React from 'react';
import { act, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { asTeamJwt, asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import { collabCommentControllerRegistry } from '@nimbalyst/runtime/editor/commenting/CollabCommentControllerRegistry';
import { withHeadlessLexicalBridge } from '@nimbalyst/runtime/sync/withHeadlessLexicalBridge';
import { HeadlessBodyNodes } from '@nimbalyst/runtime/editor/nodes/headlessBodyNodes';
import { $createParagraphNode, $getRoot, $getSelection, type LexicalEditor, type RangeSelection } from 'lexical';
import { getAllExtensionUserCommands } from '@nimbalyst/runtime/editor/extensions/extensionContributionsStore';
import { uint8ArrayToBase64, base64ToUint8Array } from '@nimbalyst/runtime/sync/documentSyncBase64';
import { $createEmbeddedFileNode } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/EmbeddedFileNode';
import { createNamedPageViewsController } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/namedPageViewsController';
import { MarkdownCollabContentAdapter } from '@nimbalyst/runtime/sync/MarkdownCollabContentAdapter';
import { buildTrackerReferenceHref } from '@nimbalyst/runtime/plugins/TrackerLinkPlugin/trackerReferenceHref';
import { decisionMembersFromComments, mountCollabEditor } from '../mount';
import { registerEmbeddableExtension } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/embeddableExtensions';
import { setConsoleLinkOpener, setPageReferenceOpener } from '../consoleLinkOpener';
import { CollabPresenceSurface } from '../presence';
import {
  asTeamDocumentId,
  asTeamOrgId,
  asTeamProjectId,
  type CollabEditorCommentsOptions,
  type CollabEditorMountOptions,
  type CollabEditorHandle,
} from '../types';

const mountedHandles: CollabEditorHandle[] = [];

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 20; index++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let index = 0; index < 20; index++) await Promise.resolve();
  });
}

afterEach(() => {
  for (const handle of mountedHandles.splice(0)) handle.destroy();
  document.body.replaceChildren();
});

describe('in-memory collaborative editor harness', () => {
  it('edits named views through the browser document and withdraws the editor on teardown', async () => {
    const yDocument = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(yDocument, 'Preserve the type description.');
    const element = document.createElement('div'); document.body.append(element);
    let editor: LexicalEditor | null = null;
    const handle = mountCollabEditor({ element, source: { kind: 'in-memory', document: yDocument }, user: { memberId: asTeamMemberId('author'), name: 'Author' }, onLexicalEditor: value => { editor = value; } });
    mountedHandles.push(handle);
    await settle();
    expect(editor).not.toBeNull();
    const views = createNamedPageViewsController(editor!, 'task');
    await act(async () => views.add('browser-view', 'Open tasks', { mode: 'list' }));
    await settle();
    expect(handle.getMarkdown()).toContain('```page-view');
    expect(handle.getMarkdown()).toContain('Preserve the type description.');
    await act(async () => handle.setReadOnly(true));
    await settle();
    expect(() => views.patch('browser-view', { mode: 'board' })).toThrow('not editable');
    await act(async () => handle.destroy());
    expect(editor).toBeNull();
    views.dispose();
  });
  it('renders persisted subject embeds through each mount’s authorized preview without crossing scopes', async () => {
    const mounts = ['one', 'two'].map((scope) => {
      const yDocument = new Y.Doc();
      withHeadlessLexicalBridge(yDocument, { nodes: HeadlessBodyNodes }, ({ editor }) => {
        editor.update(() => $getRoot().append($createEmbeddedFileNode({
          src: `nimbalyst://doc/preview-${scope}?orgId=org-${scope}`,
          label: `Preview ${scope}`, attrs: { embedType: '.mockup.html', width: '640', height: '480' },
        })), { discrete: true });
      });
      const element = document.createElement('div'); document.body.append(element);
      const render = vi.fn((_key: string, artifact: string, _embed?: unknown) => <div data-testid="live-subject-preview">{scope}: {artifact}</div>);
      const handle = mountCollabEditor({ element, source: { kind: 'in-memory', document: yDocument }, user: { memberId: asTeamMemberId(scope), name: scope }, renderDecisionArtifact: render });
      mountedHandles.push(handle);
      return { element, handle, render, scope };
    });
    await settle();
    for (const { element, scope } of mounts) {
      await waitFor(() => expect(element.querySelector('[data-testid="live-subject-preview"]')?.textContent).toBe(`${scope}: collab://org:org-${scope}:doc:preview-${scope}`));
      expect(element.querySelector('[data-testid="embed-frame-placeholder"]')).toBeNull();
    }
    // The host sizes the preview from the link title, as the desktop embed does.
    expect(mounts[0]!.render.mock.calls[0]?.[2]).toEqual({ label: 'Preview one', attrs: { embedType: '.mockup.html', width: '640', height: '480' } });
    await act(async () => mounts[0]!.handle.destroy());
    await act(async () => mounts[1]!.handle.setReadOnly(true));
    await settle();
    expect(mounts[1]!.element.querySelector('[data-testid="live-subject-preview"]')?.textContent).toContain('two: collab://org:org-two:doc:preview-two');
    expect(mounts[0]!.render.mock.calls.every(([, artifact]) => artifact.includes('org-one'))).toBe(true);
    expect(mounts[1]!.render.mock.calls.every(([, artifact]) => artifact.includes('org-two'))).toBe(true);
  });

  it.each([
    { src: '/private/preview.mockup.html', capable: true },
    { src: 'nimbalyst://doc/preview?orgId=org-one', capable: false },
  ])('keeps embedded subjects unavailable without a shared target and host capability: $src', async ({ src, capable }) => {
    const yDocument = new Y.Doc();
    withHeadlessLexicalBridge(yDocument, { nodes: HeadlessBodyNodes }, ({ editor }) => editor.update(() => {
      $getRoot().append($createEmbeddedFileNode({ src, label: 'Preview', attrs: { embedType: '.mockup.html' } }));
    }, { discrete: true }));
    const element = document.createElement('div'); document.body.append(element);
    const render = vi.fn(() => <div>Must not render</div>);
    const handle = mountCollabEditor({ element, source: { kind: 'in-memory', document: yDocument }, user: { memberId: asTeamMemberId('member'), name: 'Member' }, ...(capable ? { renderDecisionArtifact: render } : {}) });
    mountedHandles.push(handle);
    await settle();
    await waitFor(() => expect(element.querySelector('.collab-bundle-document-embed-unavailable')).not.toBeNull());
    expect(render).not.toHaveBeenCalled();
  });

  it('uses the roster team member id rather than personal org identity for decision addressing', () => {
    expect(decisionMembersFromComments([{ userId: 'member-in-team', personalOrgId: 'personal-org', name: 'Alex' }])).toEqual([{ id: 'member-in-team', name: 'Alex' }]);
  });
  it('paints a pre-populated Y.Doc through the provider bridge and accepts input', async () => {
    const yDocument = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(yDocument, '# Bundle harness\n\nPREPOPULATED-MARKER');
    const element = globalThis.document.createElement('div');
    globalThis.document.body.append(element);

    let ready = false;
    const handle = mountCollabEditor({
      element,
      source: { kind: 'in-memory', document: yDocument },
      user: {
        memberId: asTeamMemberId('member-harness'),
        name: 'Harness User',
        cursorColor: '#3366ff',
      },
      onReady: () => { ready = true; },
    });
    mountedHandles.push(handle);

    await settle();
    const editable = element.querySelector<HTMLElement>('[contenteditable="true"]');
    expect(ready).toBe(true);
    expect(editable?.textContent).toContain('PREPOPULATED-MARKER');

    await act(async () => handle.insertText(' ACCEPTED-INPUT'));
    await settle();

    expect(editable?.textContent).toContain('ACCEPTED-INPUT');
    expect(handle.getMarkdown()).toContain('ACCEPTED-INPUT');
    expect(handle.getState()).toMatchObject({
      connection: 'local',
      edit: 'dirty',
      hostReadOnly: false,
      serverAccess: 'not-applicable',
      termination: null,
    });
    await expect(handle.flush()).resolves.toEqual({
      status: 'not-required',
      reason: 'in-memory',
    });

    // Page history restore: the whole body is replaced through the live
    // editor, so the collaborative document (what peers see) holds it too.
    await act(async () => handle.replaceMarkdown!('# Restored version\n\nRESTORED-MARKER'));
    await settle();
    expect(editable?.textContent).not.toContain('PREPOPULATED-MARKER');
    expect(MarkdownCollabContentAdapter.exportToFile(yDocument)).toContain('RESTORED-MARKER');
    handle.setReadOnly(true);
    expect(() => handle.replaceMarkdown!('# Not allowed')).toThrow('read-only');
  });

  it('records browser decision votes in the shared document using the team member identity', async () => {
    const yDocument = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(yDocument, '```decision\nid: browser-q\nask: Ship this?\ntype: singleSelect\noptions:\n  - id: yes\n    label: Ship it\n  - id: no\n    label: Wait\n```');
    const element = document.createElement('div'); document.body.append(element);
    // Shared ballots stay disabled until a privacy-aware server authorizes the
    // list. A transport-free in-memory mount cannot supply that authority.
    const socket = new FakeRoomSocket();
    socket.decisionDocument = yDocument;
    const handle = mountCollabEditor({
      element,
      source: {
        kind: 'team-room', serverUrl: 'ws://collab.test',
        room: { orgId: asTeamOrgId('org-votes'), projectId: asTeamProjectId('project-votes'), documentId: asTeamDocumentId('doc-votes') },
        auth: { scope: 'team', memberId: asTeamMemberId('team-reader'), getTeamJwt: async () => asTeamJwt('team-jwt') },
        createWebSocket: () => socket as unknown as WebSocket,
      },
      user: { memberId: asTeamMemberId('team-reader'), name: 'Reader' },
    });
    mountedHandles.push(handle);
    await settle();
    await act(async () => { socket.open(); socket.deliverSyncResponse(true); });
    await waitFor(() => expect(element.querySelector('button[data-testid="decision-option-row"]')).not.toBeNull());
    const option = [...element.querySelectorAll('button')].find((button) => button.textContent?.includes('Ship it'))!;
    fireEvent.click(option);
    fireEvent.click(element.querySelector('[data-testid="decision-answer"]')!);
    await waitFor(() => expect(yDocument.getMap('decisions').get('browser-q\x1fteam-reader')).toMatchObject({ answer: { type: 'singleSelect', selectedId: 'yes' } }));
  });

  it('answers a decision on a page with no room, like a local file, instead of waiting for answer status', async () => {
    const yDocument = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(yDocument, '```decision\nask: Retry on weekends?\ntype: singleSelect\noptions:\n  - id: always\n    label: Always\n  - id: never\n    label: Never\n```');
    const element = document.createElement('div'); document.body.append(element);
    const handle = mountCollabEditor({ element, source: { kind: 'in-memory', document: yDocument }, user: { memberId: asTeamMemberId('local'), name: 'You' } });
    mountedHandles.push(handle);
    await settle();
    await waitFor(() => expect(element.querySelector('button[data-testid="decision-option-row"]')).not.toBeNull());
    expect(element.textContent).not.toContain('Loading answer status');
    fireEvent.click([...element.querySelectorAll('button')].find((button) => button.textContent?.includes('Always'))!);
    fireEvent.click(element.querySelector('[data-testid="decision-answer"]')!);
    await waitFor(() => expect(handle.getMarkdown()).toMatch(/\nresolved: always\n/));
    expect(handle.getMarkdown()).toMatch(/\nid: dcn-[0-9a-f]{6}\n/);
    expect(yDocument.getMap('decisions').size).toBe(0);
  });

  it('writes references inserted in a team room as that project\'s console links', () => {
    const element = document.createElement('div'); document.body.append(element);
    const handle = mountCollabEditor({
      element,
      source: {
        kind: 'team-room', serverUrl: 'ws://collab.test',
        room: { orgId: asTeamOrgId('org-1'), projectId: asTeamProjectId('project-1'), documentId: asTeamDocumentId('doc-1') },
        auth: { scope: 'team', memberId: asTeamMemberId('team-reader'), getTeamJwt: async () => asTeamJwt('team-jwt') },
        createWebSocket: () => new FakeRoomSocket() as unknown as WebSocket,
      },
      user: { memberId: asTeamMemberId('team-reader'), name: 'Reader' },
    });
    expect(buildTrackerReferenceHref('NIM-1')).toBe('https://console.nimbalyst.com/org/org-1/project/project-1/page/item/NIM-1');
    handle.destroy();
    expect(buildTrackerReferenceHref('NIM-1')).toBeNull();
  });

  it('offers placed views in the slash menu and writes them as that project\'s console view links', async () => {
    const element = document.createElement('div'); document.body.append(element);
    const handle = mountCollabEditor({
      element,
      source: {
        kind: 'team-room', serverUrl: 'ws://collab.test',
        room: { orgId: asTeamOrgId('org-1'), projectId: asTeamProjectId('project-1'), documentId: asTeamDocumentId('doc-1') },
        auth: { scope: 'team', memberId: asTeamMemberId('team-writer'), getTeamJwt: async () => asTeamJwt('team-jwt') },
        createWebSocket: () => new FakeRoomSocket() as unknown as WebSocket,
      },
      user: { memberId: asTeamMemberId('team-writer'), name: 'Writer' },
      placedViewTypes: {
        list: () => [
          { type: 'competitor', displayName: 'Competitor', displayNamePlural: 'Competitors', fields: [{ name: 'reach', type: 'number' }, { name: 'price', type: 'number' }, { name: 'title', type: 'string' }] },
          { type: 'module', displayName: 'Module', fields: [{ name: 'title', type: 'string' }] },
        ],
        subscribe: () => () => undefined,
      },
    });
    const titles = () => getAllExtensionUserCommands().map((command) => command.title);
    await waitFor(() => expect(titles()).toEqual(expect.arrayContaining(['Table: Competitors', '2x2: Competitors', 'Table: Module', 'Decisions list', 'Open questions list'])));
    expect(titles()).not.toContain('2x2: Module');

    const editable = await waitFor(() => {
      const found = element.querySelector('[contenteditable]') as (HTMLElement & { __lexicalEditor?: LexicalEditor }) | null;
      expect(found?.__lexicalEditor).toBeTruthy();
      return found!;
    });
    const editor = editable.__lexicalEditor!;
    const entry = getAllExtensionUserCommands().find((command) => command.title === '2x2: Competitors')!;
    act(() => {
      editor.update(() => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.select();
        editor.dispatchCommand(entry.command, entry.payload);
      }, { discrete: true });
    });
    const placed = editor.getEditorState().read(() => $getRoot().getChildren().find((node) => node.getType() === 'embedded-file')?.exportJSON()) as { src: string; attrs: Record<string, string> } | undefined;
    expect(placed?.src).toBe('https://console.nimbalyst.com/org/org-1/project/project-1/view/type/competitor');
    expect(placed?.attrs).toEqual({ mode: '2x2', x: 'reach', y: 'price' });

    handle.destroy();
    expect(titles()).not.toContain('Decisions list');
  });

  it('links pages from @ as plain relative markdown links, and creates a page from it', async () => {
    const yDocument = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(yDocument, 'Start');
    const element = document.createElement('div'); document.body.append(element);
    let editor: LexicalEditor | null = null;
    let finishCreate: (option: { id: string; title: string; href: string; linkTitle: string }) => void = () => {};
    const handle = mountCollabEditor({
      element,
      source: { kind: 'in-memory', document: yDocument },
      user: { memberId: asTeamMemberId('local'), name: 'You' },
      onLexicalEditor: (value) => { editor = value; },
      pageLinks: {
        list: () => [
          { id: 'P1', title: 'Q3 Plan', href: 'Q3%20Plan.md', linkTitle: 'id=P1' },
          { id: 'P2', title: 'Personas', href: 'Personas.md', linkTitle: 'id=P2' },
        ],
        createPage: () => new Promise((resolve) => { finishCreate = resolve; }),
      },
    });
    mountedHandles.push(handle);
    await settle();
    const type = async (text: string) => {
      act(() => {
        editor!.update(() => {
          const paragraph = $createParagraphNode();
          $getRoot().append(paragraph);
          paragraph.select();
        }, { discrete: true });
      });
      for (const ch of text) act(() => { editor!.update(() => (($getSelection() as RangeSelection)).insertText(ch), { discrete: true }); });
      await settle();
    };
    const pick = async (label: string) => {
      const option = await waitFor(() => {
        const found = [...document.querySelectorAll('[role="option"]')].find((node) => node.textContent?.includes(label));
        expect(found).toBeTruthy();
        return found as HTMLElement;
      });
      fireEvent.click(option);
      await settle();
    };

    await type('@q3');
    await pick('Q3 Plan');
    expect(handle.getMarkdown()).toContain('[Q3 Plan](Q3%20Plan.md "id=P1")');

    await type('@Launch');
    await pick('Create page “Launch”');
    act(() => finishCreate({ id: 'P3', title: 'Launch', href: 'Launch.md', linkTitle: 'id=P3' }));
    await settle();
    expect(handle.getMarkdown()).toContain('[Launch](Launch.md "id=P3")');
    expect(handle.getMarkdown()).not.toContain('nimbalyst://');
  });

  it('draws an embedded file link through the host, and writes the link back unchanged', async () => {
    registerEmbeddableExtension('.excalidraw');
    const source = 'Before\n\n[Diagram](Plan/Diagram.excalidraw "width=800 height=600")\n\nAfter\n';
    const yDocument = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(yDocument, source);
    const element = document.createElement('div'); document.body.append(element);
    const requests: unknown[] = [];
    const handle = mountCollabEditor({
      element,
      source: { kind: 'in-memory', document: yDocument },
      user: { memberId: asTeamMemberId('local'), name: 'You' },
      renderFileEmbed: (embed) => {
        requests.push(embed);
        return <div data-testid="host-file-embed">{embed.label}</div>;
      },
    });
    mountedHandles.push(handle);
    await waitFor(() => expect(element.querySelector('[data-testid="host-file-embed"]')?.textContent).toBe('Diagram'));
    expect(requests[0]).toEqual({ src: 'Plan/Diagram.excalidraw', label: 'Diagram', attrs: { width: '800', height: '600' } });
    expect(String(MarkdownCollabContentAdapter.exportToFile(yDocument))).toContain('[Diagram](Plan/Diagram.excalidraw "width=800 height=600")');
  });

  it('paints tracker and shared-document references written by a desktop client', async () => {
    // A desktop client's node set is wider than the bundle's. A Y.Doc holding
    // either reference node used to abort the whole binding with
    // "Node <type> is not registered", so the document never painted.
    const yDocument = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(
      yDocument,
      'Blocked by [NIM-123](nimbalyst://NIM-123), see [Launch Plan](nimbalyst://doc/fa164469-0e2b-4f1a-9c2d-6b1f0a3d5e77).',
    );
    const element = globalThis.document.createElement('div');
    globalThis.document.body.append(element);

    const errors: string[] = [];
    const handle = mountCollabEditor({
      element,
      source: { kind: 'in-memory', document: yDocument },
      user: {
        memberId: asTeamMemberId('member-references'),
        name: 'Reference User',
      },
      onError: (error) => { errors.push(error.message); },
    });
    mountedHandles.push(handle);
    await settle();

    const editable = element.querySelector<HTMLElement>('[contenteditable="true"]');
    expect(errors).toEqual([]);
    expect(editable?.textContent).toContain('NIM-123');
    expect(editable?.textContent).toContain('Launch Plan');
    expect(handle.getMarkdown()).toContain('[NIM-123](nimbalyst://NIM-123)');
    expect(handle.getMarkdown()).toContain(
      '(nimbalyst://doc/fa164469-0e2b-4f1a-9c2d-6b1f0a3d5e77)',
    );
  });

  it('shows a reference to someone\'s Personal page as on the author\'s device, opened through the host, never resolved here', async () => {
    const yDocument = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(
      yDocument,
      'Mine is [NIM-7](https://console.nimbalyst.com/app/item/NIM-7) and ours is [NIM-8](nimbalyst://NIM-8).',
    );
    const element = globalThis.document.createElement('div');
    globalThis.document.body.append(element);
    const opened: string[] = [];
    const stopOpener = setConsoleLinkOpener((href) => { opened.push(href); return true; });
    const handle = mountCollabEditor({ element, source: { kind: 'in-memory', document: yDocument }, user: { memberId: asTeamMemberId('member'), name: 'Member' } });
    mountedHandles.push(handle);
    await settle();

    const personal = element.querySelectorAll('[data-testid="tracker-reference-author-device"]');
    expect(personal).toHaveLength(1);
    expect(personal[0]!.textContent).toContain('on the author\'s device');
    expect(element.querySelector('[data-issue-key="NIM-8"]:not([data-testid="tracker-reference-author-device"])')).not.toBeNull();
    fireEvent.click(personal[0]!);
    expect(opened).toEqual(['https://console.nimbalyst.com/app/item/NIM-7']);
    stopOpener();
  });

  it('opens a link to another page through the host in this tab, and a Cmd+click in a new browser tab', async () => {
    const href = 'https://console.nimbalyst.com/org/o1/project/p1/document/d2';
    const yDocument = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(yDocument, `See [Launch Plan](${href}).`);
    const element = globalThis.document.createElement('div');
    globalThis.document.body.append(element);
    const opened: string[] = [];
    const stopOpener = setConsoleLinkOpener((link) => { opened.push(link); return true; });
    const windowOpen = vi.spyOn(window, 'open').mockReturnValue(null);
    const handle = mountCollabEditor({ element, source: { kind: 'in-memory', document: yDocument }, user: { memberId: asTeamMemberId('member'), name: 'Member' } });
    mountedHandles.push(handle);
    await settle();

    const anchor = element.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)!;
    fireEvent.click(anchor);
    expect(opened).toEqual([href]);
    expect(windowOpen).not.toHaveBeenCalled();

    fireEvent.click(anchor, { metaKey: true });
    expect(opened).toEqual([href]);
    expect(windowOpen).toHaveBeenCalledWith(href, '_blank', 'noopener,noreferrer');
    windowOpen.mockRestore();
    stopOpener();
  });

  it('opens an @ reference to a team page through the host, in a new tab on Cmd+click', async () => {
    const yDocument = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(yDocument, 'See [Launch Plan](nimbalyst://doc/d2?orgId=o1).');
    const element = globalThis.document.createElement('div');
    globalThis.document.body.append(element);
    const opened: Array<[string, boolean]> = [];
    const stopOpener = setPageReferenceOpener((documentId, { newTab }) => { opened.push([documentId, newTab]); });
    const handle = mountCollabEditor({ element, source: { kind: 'in-memory', document: yDocument }, user: { memberId: asTeamMemberId('member'), name: 'Member' } });
    mountedHandles.push(handle);
    await settle();

    const chip = element.querySelector<HTMLElement>('.document-reference')!;
    fireEvent.click(chip);
    fireEvent.click(chip, { metaKey: true });
    expect(opened).toEqual([['d2', false], ['d2', true]]);
    stopOpener();
  });

  it('opens find in the document on Cmd+F and asks the host to save on Cmd+S, only when the host opts in', async () => {
    const mount = (findInPage: boolean, onSaveRequest?: () => void) => {
      const yDocument = new Y.Doc();
      MarkdownCollabContentAdapter.seedFromFile(yDocument, 'Find marker');
      const element = document.createElement('div'); document.body.append(element);
      mountedHandles.push(mountCollabEditor({ element, source: { kind: 'in-memory', document: yDocument }, user: { memberId: asTeamMemberId('local'), name: 'You' }, findInPage, onSaveRequest }));
      return element;
    };
    const saves = vi.fn();
    const withFind = mount(true, saves);
    const editable = await waitFor(() => {
      const found = withFind.querySelector<HTMLElement>('[contenteditable="true"]');
      expect(found).toBeTruthy();
      return found!;
    });
    const find = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', metaKey: true, bubbles: true, cancelable: true });
    act(() => { editable.dispatchEvent(find); });
    expect(find.defaultPrevented).toBe(true);
    await waitFor(() => expect(withFind.querySelector('[data-testid="search-input"]')).toBe(document.activeElement));

    // The editor reads Cmd on Apple platforms and Ctrl elsewhere, as Lexical decides it.
    const apple = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
    act(() => { editable.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', metaKey: apple, ctrlKey: !apple, bubbles: true, cancelable: true })); });
    expect(saves).toHaveBeenCalledOnce();

    const plain = mount(false);
    const plainEditable = await waitFor(() => {
      const found = plain.querySelector<HTMLElement>('[contenteditable="true"]');
      expect(found).toBeTruthy();
      return found!;
    });
    const browserFind = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', metaKey: true, bubbles: true, cancelable: true });
    act(() => { plainEditable.dispatchEvent(browserFind); });
    expect(browserFind.defaultPrevented).toBe(false);
    expect(plain.querySelector('[data-testid="search-input"]')).toBeNull();
  });

  it('carries no formatting toolbar and applies the browser-host chrome', async () => {
    const yDocument = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(yDocument, 'Chrome marker');
    const element = globalThis.document.createElement('div');
    globalThis.document.body.append(element);

    const handle = mountCollabEditor({
      element,
      source: { kind: 'in-memory', document: yDocument },
      user: {
        memberId: asTeamMemberId('member-chrome'),
        name: 'Chrome User',
        cursorColor: '#3366ff',
      },
    });
    mountedHandles.push(handle);
    await settle();

    // The desktop document editor has no top toolbar; this host must match it.
    expect(element.querySelector('.toolbar')).toBeNull();
    expect(element.querySelector<HTMLElement>('.editor-scroller')?.classList.contains('select-text'))
      .toBe(true);
    // Remote carets would otherwise read collaborators' names into the prose.
    expect(element.querySelector('.collab-cursors-container')?.getAttribute('aria-hidden'))
      .toBe('true');
  });

  it('announces lifecycle departure and rejoins when the document becomes active', async () => {
    const setActive = vi.spyOn(CollabPresenceSurface.prototype, 'setActive');
    const visibilityState = vi.spyOn(document, 'visibilityState', 'get');
    const element = document.createElement('div');
    document.body.append(element);
    const handle = mountCollabEditor({
      element,
      source: { kind: 'in-memory', document: new Y.Doc() },
      user: {
        memberId: asTeamMemberId('member-lifecycle'),
        name: 'Lifecycle User',
      },
    });
    mountedHandles.push(handle);
    await settle();

    window.dispatchEvent(new Event('pagehide'));
    expect(setActive).toHaveBeenLastCalledWith(false);

    window.dispatchEvent(new Event('pageshow'));
    expect(setActive).toHaveBeenLastCalledWith(true);

    visibilityState.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(setActive).toHaveBeenLastCalledWith(false);

    visibilityState.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(setActive).toHaveBeenLastCalledWith(true);

    handle.setPresenceActive(false);
    expect(setActive).toHaveBeenLastCalledWith(false);
    handle.setPresenceActive(true);
    expect(setActive).toHaveBeenLastCalledWith(true);
    visibilityState.mockRestore();
    setActive.mockRestore();
  });
});

/**
 * A room socket that opens and answers the initial sync, and nothing else.
 *
 * That is precisely the state a reader is in: the document arrived, no edit has
 * been attempted, so the server has never acknowledged or refused a write.
 */
class FakeRoomSocket {
  static readonly opened: FakeRoomSocket[] = [];
  readyState = 0;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor() {
    FakeRoomSocket.opened.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const current = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  decisionDocument?: Y.Doc;

  send(data: string): void {
    if (!this.decisionDocument) return;
    const message = JSON.parse(data);
    if (message.type === 'docDecisionCommand' && message.command.operation === 'list') {
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'docDecisionState', requestId: message.requestId, decisions: [], privacyVersion: 1 }) }));
    }
    if (message.type === 'docUpdate') {
      Y.applyUpdate(this.decisionDocument, base64ToUint8Array(message.encryptedUpdate));
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'docUpdateAck', clientUpdateId: message.clientUpdateId }) }));
    }
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  /**
   * The server's answer to `docSyncRequest`. `canWrite` is omitted to stand in
   * for a server that predates the verdict, which is how the client's fallback
   * to its own host answer stays covered.
   */
  deliverSyncResponse(canWrite?: boolean, canComment?: boolean): void {
    this.emit('message', {
      data: JSON.stringify({
        type: 'docSyncResponse',
        updates: this.decisionDocument ? [{ sequence: 1, encryptedUpdate: uint8ArrayToBase64(Y.encodeStateAsUpdate(this.decisionDocument)), iv: '' }] : [],
        hasMore: false,
        cursor: 0,
        serverHead: 0,
        serverHasState: true,
        ...(canWrite === undefined ? {} : { canWrite }),
        ...(canComment === undefined ? {} : { canComment }),
      }),
    });
  }

  /**
   * The room demoting a connected editor to commenter mid-session (a role
   * change), which the server sends instead of `document_read_only`.
   */
  deliverCommentOnlyDemotion(): void {
    this.emit('message', {
      data: JSON.stringify({
        type: 'error',
        code: 'document_comment_only',
        message: 'Your current role now permits commenting on this document but not editing it',
      }),
    });
  }

  /** The room granting body write to an open connection (a role change). */
  deliverWritableGrant(): void {
    this.emit('message', {
      data: JSON.stringify({
        type: 'error',
        code: 'document_writable',
        message: 'Your current role now permits editing this document',
      }),
    });
  }

  /** The room refusing a commenter update that touched more than comments. */
  deliverCommentUpdateRefusal(clientUpdateId: string): void {
    this.emit('message', {
      data: JSON.stringify({
        type: 'error',
        code: 'document_comment_update_refused',
        message: 'Commenters may only change comment threads',
        clientUpdateId,
      }),
    });
  }

  deliverWriteAcknowledged(): void {
    this.emit('message', {
      data: JSON.stringify({ type: 'docUpdateAck', clientUpdateId: 'probe-access' }),
    });
  }

  /** The server refusing a write, which is how a stale host answer is corrected. */
  deliverReadOnlyRefusal(): void {
    this.emit('message', {
      data: JSON.stringify({
        type: 'error',
        code: 'document_read_only',
        message: 'Your current role permits reading this document but not editing it',
      }),
    });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe('comment authoring on a document that has not been written to', () => {
  async function openTeamDocument(
    documentId: string,
    canComment: () => boolean,
    serverCanWrite?: boolean,
    extra: {
      serverCanComment?: boolean;
      canEditBody?: () => boolean;
      onTermination?: CollabEditorMountOptions['onTermination'];
    } = {},
  ): Promise<{ handle: CollabEditorHandle; documentUri: string; element: HTMLElement }> {
    FakeRoomSocket.opened.length = 0;
    const element = document.createElement('div');
    document.body.append(element);
    const documentUri = `nimbalyst://doc/${documentId}`;
    const comments: CollabEditorCommentsOptions = {
      currentUser: { id: 'member-reader', name: 'Reader' },
      getMembers: () => [],
      documentTitle: 'Shared plan',
      documentId,
      documentUri,
      canComment,
      ...(extra.canEditBody ? { canEditBody: extra.canEditBody } : {}),
    };
    const handle = mountCollabEditor({
      element,
      source: {
        kind: 'team-room',
        serverUrl: 'ws://collab.test',
        room: {
          orgId: asTeamOrgId('org-comments'),
          projectId: asTeamProjectId('project-comments'),
          documentId: asTeamDocumentId(documentId),
        },
        auth: {
          scope: 'team',
          memberId: asTeamMemberId('member-reader'),
          getTeamJwt: async () => asTeamJwt('team-jwt'),
        },
        createWebSocket: () => new FakeRoomSocket() as unknown as WebSocket,
      },
      user: { memberId: asTeamMemberId('member-reader'), name: 'Reader' },
      comments,
      onTermination: extra.onTermination,
    });
    mountedHandles.push(handle);
    await settle();

    const socket = FakeRoomSocket.opened[0];
    if (!socket) throw new Error('the editor never opened a room socket');
    await act(async () => {
      socket.open();
      socket.deliverSyncResponse(serverCanWrite, extra.serverCanComment);
    });
    await settle();
    return { handle, documentUri, element };
  }

  function commentCapability(documentUri: string): boolean {
    const controller = collabCommentControllerRegistry.get(documentUri);
    if (!controller) throw new Error('the comment plugin never registered a controller');
    return controller.getCapabilities().comment;
  }

  function commentController(documentUri: string) {
    const controller = collabCommentControllerRegistry.get(documentUri);
    if (!controller) throw new Error('the comment plugin never registered a controller');
    return controller;
  }

  it('lets a permitted host author on a document it has never written to', async () => {
    // The server only ever acknowledges a write it was asked to make, so a
    // document opened to be annotated stays at 'unknown' for its whole session.
    // Authoring has to be available there or the comment panel is unusable.
    const writer = await openTeamDocument('doc-writer', () => true);
    expect(writer.handle.getState()).toMatchObject({
      connection: 'connected',
      serverAccess: 'unknown',
    });
    expect(commentCapability(writer.documentUri)).toBe(true);
    // Reaching anchor resolution at all is the point: this attempt used to be
    // turned away as COMMENT_FORBIDDEN before the anchor was ever looked at.
    await expect(commentController(writer.documentUri).createAnchored({
      anchor: { exact: 'not present' },
      body: 'Authored before any edit',
      clientMutationId: 'unknown-access-attempt',
    }, {
      kind: 'user',
      userId: 'member-reader',
      displayName: 'Reader',
    })).rejects.toMatchObject({ code: 'ANCHOR_NOT_FOUND' });
  });

  it('takes the sync response write verdict without waiting for a write', async () => {
    // A server that reports access on connect settles this before the user
    // touches anything, so a downgraded member is never offered an affordance
    // that would bounce.
    const writer = await openTeamDocument('doc-verdict-writer', () => true, true);
    expect(writer.handle.getState()).toMatchObject({
      serverAccess: 'writable',
      readOnly: false,
    });
    expect(commentCapability(writer.documentUri)).toBe(true);

    const downgraded = await openTeamDocument('doc-verdict-reader', () => true, false);
    expect(downgraded.handle.getState()).toMatchObject({
      serverAccess: 'read-only',
      readOnly: true,
    });
    expect(commentCapability(downgraded.documentUri)).toBe(false);
  });

  it('refuses a host that says no, and withdraws on a server write refusal', async () => {
    const viewer = await openTeamDocument('doc-viewer', () => false);
    expect(viewer.handle.getState()).toMatchObject({
      connection: 'connected',
      serverAccess: 'unknown',
    });
    expect(commentCapability(viewer.documentUri)).toBe(false);
    await expect(commentController(viewer.documentUri).createAnchored({
      anchor: { exact: 'not present' },
      body: 'Must not be written locally',
      clientMutationId: 'viewer-attempt',
    }, {
      kind: 'user',
      userId: 'member-reader',
      displayName: 'Reader',
    })).rejects.toMatchObject({ code: 'COMMENT_FORBIDDEN' });
    expect(viewer.handle.getDocument().getArray('comments')).toHaveLength(0);

    // A host answer that has gone stale is corrected by the server's refusal
    // rather than by withholding the affordance up front.
    const stale = await openTeamDocument('doc-downgraded', () => true);
    expect(commentCapability(stale.documentUri)).toBe(true);
    const staleSocket = FakeRoomSocket.opened[0];
    if (!staleSocket) throw new Error('the downgraded member never opened a room socket');
    await act(async () => staleSocket.deliverReadOnlyRefusal());
    expect(stale.handle.getState()).toMatchObject({ serverAccess: 'read-only' });
    expect(commentCapability(stale.documentUri)).toBe(false);
  });

  it('keeps commenting for a commenter verdict instead of demoting to read-only', async () => {
    // canWrite false alone is a reader; with canComment it is a commenter,
    // which the server reports even when the host roster cannot see the grant.
    const commenter = await openTeamDocument('doc-commenter', () => true, false, {
      serverCanComment: true,
    });
    expect(commenter.handle.getState()).toMatchObject({
      serverAccess: 'comment-only',
      readOnly: true,
    });
    expect(commentController(commenter.documentUri).getCapabilities()).toEqual({
      read: true,
      comment: true,
      editBody: false,
    });

    // The room acknowledges a commenter's comment updates; that is not
    // evidence the body became writable.
    const socket = FakeRoomSocket.opened[0]!;
    await act(async () => socket.deliverWriteAcknowledged());
    expect(commenter.handle.getState()).toMatchObject({ serverAccess: 'comment-only' });

    // A host commenter answer locks the body even on a writable verdict.
    const hostCommenter = await openTeamDocument('doc-host-commenter', () => true, true, {
      canEditBody: () => false,
    });
    expect(hostCommenter.handle.getState()).toMatchObject({ readOnly: true });
    expect(commentController(hostCommenter.documentUri).getCapabilities()).toMatchObject({
      comment: true,
      editBody: false,
    });
  });

  it('switches a connected editor to commenter mode when the room demotes it, and back on a writable verdict', async () => {
    const editor = await openTeamDocument('doc-demoted', () => true, true);
    const body = editor.element.querySelector('[contenteditable]');
    expect(body?.getAttribute('contenteditable')).toBe('true');
    expect(commentController(editor.documentUri).getCapabilities()).toMatchObject({
      comment: true,
      editBody: true,
    });

    const socket = FakeRoomSocket.opened[0]!;
    await act(async () => socket.deliverCommentOnlyDemotion());
    await settle();

    // Read-only body, commenting kept, socket still open: not a termination.
    expect(editor.handle.getState()).toMatchObject({
      connection: 'connected',
      serverAccess: 'comment-only',
      readOnly: true,
      termination: null,
    });
    expect(editor.element.querySelector('[contenteditable="true"]')).toBeNull();
    expect(editor.element.querySelector('[contenteditable="false"]')).not.toBeNull();
    expect(commentController(editor.documentUri).getCapabilities()).toEqual({
      read: true,
      comment: true,
      editBody: false,
    });
    // An ack for an update sent before the demotion does not restore editing.
    await act(async () => socket.deliverWriteAcknowledged());
    expect(editor.handle.getState()).toMatchObject({ serverAccess: 'comment-only', readOnly: true });

    // A later verdict that grants writing (the next sync response) does.
    await act(async () => socket.deliverSyncResponse(true, true));
    await settle();
    expect(editor.handle.getState()).toMatchObject({ serverAccess: 'writable', readOnly: false });
    expect(editor.element.querySelector('[contenteditable="true"]')).not.toBeNull();
    expect(commentController(editor.documentUri).getCapabilities()).toMatchObject({
      comment: true,
      editBody: true,
    });
  });

  it('unlocks a commenter granted write mid-session, without reconnecting', async () => {
    const commenter = await openTeamDocument('doc-promoted', () => true, false, {
      serverCanComment: true,
    });
    const root = () => commenter.handle.getDocument().get('root', Y.XmlText).toString();
    const before = root();
    await act(async () => commenter.handle.insertText(' LOCKED-INPUT'));
    expect(root()).toBe(before);

    const socket = FakeRoomSocket.opened[0]!;
    await act(async () => socket.deliverWritableGrant());
    await settle();
    expect(commenter.handle.getState()).toMatchObject({
      connection: 'connected',
      serverAccess: 'writable',
      readOnly: false,
      termination: null,
    });
    expect(commentController(commenter.documentUri).getCapabilities()).toMatchObject({
      comment: true,
      editBody: true,
    });
    const body = commenter.element.querySelector('[contenteditable="true"]');
    expect(body).not.toBeNull();
    await act(async () => commenter.handle.insertText(' GRANTED-INPUT'));
    expect(root()).toContain('GRANTED-INPUT');
    expect(FakeRoomSocket.opened).toHaveLength(1);

    // Resent after hibernation to a socket that already writes: no change.
    const settled = commenter.handle.getState();
    await act(async () => socket.deliverWritableGrant());
    await settle();
    expect(commenter.handle.getState()).toEqual(settled);
    expect(commenter.element.querySelector('[contenteditable="true"]')).toBe(body);
  });

  it('turns on commenting for a reader granted it mid-session', async () => {
    const reader = await openTeamDocument('doc-reader-granted', () => true, false);
    expect(reader.handle.getState()).toMatchObject({ serverAccess: 'read-only' });
    expect(commentCapability(reader.documentUri)).toBe(false);

    await act(async () => FakeRoomSocket.opened[0]!.deliverCommentOnlyDemotion());
    await settle();
    expect(reader.handle.getState()).toMatchObject({ serverAccess: 'comment-only', readOnly: true });
    expect(commentController(reader.documentUri).getCapabilities()).toEqual({
      read: true,
      comment: true,
      editBody: false,
    });
  });

  it('terminates with comment-update-refused when the room refuses a commenter update', async () => {
    const terminations: unknown[] = [];
    const commenter = await openTeamDocument('doc-refused', () => true, false, {
      serverCanComment: true,
      onTermination: (termination) => terminations.push(termination),
    });
    const socket = FakeRoomSocket.opened[0]!;

    await act(async () => socket.deliverCommentUpdateRefusal('client-update-3'));

    // The shape the web console's isCommentUpdateRefusal() checks to remount.
    expect(terminations).toEqual([{
      reason: 'comment-update-refused',
      closeCode: 4009,
      message: 'Commenters may only change comment threads',
      clientUpdateId: 'client-update-3',
    }]);
    expect(commenter.handle.getState()).toMatchObject({
      connection: 'terminated',
      readOnly: true,
      termination: { reason: 'comment-update-refused', closeCode: 4009 },
    });
    expect(commentCapability(commenter.documentUri)).toBe(false);
    // No reconnect on a Y.Doc the room can never accept again.
    await settle();
    expect(FakeRoomSocket.opened).toHaveLength(1);
  });
});
