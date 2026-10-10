import React from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
const render = (ui: React.ReactElement) => baseRender(ui, { wrapper: ({ children }) => <LexicalComposer initialConfig={{ namespace: 'embed-test', onError: error => { throw error; } }}>{children}</LexicalComposer> });
import { cleanup, render as baseRender, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { getEmbedPluginCallbacks } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/EmbedPluginCallbacks';
import { registerBrowserDocumentEmbeds, setBrowserPlacedViewRenderer } from '../documentEmbeds';

describe('browser document embeds', () => {
  afterEach(cleanup);

  it('says where a placed view can be seen instead of a broken document preview', () => {
    registerBrowserDocumentEmbeds();
    const Renderer = getEmbedPluginCallbacks().renderEmbed!;
    render(<Renderer src="nimbalyst://view/type/competitor" label="Competitors" attrs={{ mode: '2x2' }} nodeKey="1" />);
    expect(screen.getByTestId('placed-view-unavailable').textContent).toBe('Competitors: this live view shows in the Nimbalyst desktop app.');
  });

  it('offers a console view link as a link to its console page', () => {
    registerBrowserDocumentEmbeds();
    const Renderer = getEmbedPluginCallbacks().renderEmbed!;
    const href = 'https://console.nimbalyst.com/org/o1/project/p1/view/type/competitor';
    render(<Renderer src={href} label="Competitors" attrs={{}} nodeKey="2" />);
    expect(screen.getByRole('link', { name: 'Open Competitors' }).getAttribute('href')).toBe(href);
  });

  it('renders a placed view through the host renderer while one is installed', () => {
    registerBrowserDocumentEmbeds();
    const Renderer = getEmbedPluginCallbacks().renderEmbed!;
    const remove = setBrowserPlacedViewRenderer(({ src, label, target, attrs }) => (
      <div data-testid="host-view">{label} {src} {target.kind === 'type' ? target.typeId : ''} {attrs.columns}</div>
    ));
    const { unmount } = render(<Renderer src="nimbalyst://view/type/competitor" label="Competitors" attrs={{ columns: 'title' }} nodeKey="3" />);
    expect(screen.getByTestId('host-view').textContent).toBe('Competitors nimbalyst://view/type/competitor competitor title');
    unmount();
    remove();
    render(<Renderer src="nimbalyst://view/type/competitor" label="Competitors" attrs={{}} nodeKey="4" />);
    screen.getByTestId('placed-view-unavailable');
  });
});
