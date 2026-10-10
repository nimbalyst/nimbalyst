import './base.css';
import '@nimbalyst/collab-bundle/styles.css';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { loadTrackerPage } from '@nimbalyst/collab-bundle/trackers-ui';
import { WIKI_API_VERSION, wikiApi } from './api/client';
import { LocalTrackerDataSource } from './host/LocalTrackerDataSource';
import { loadWikiSchema } from './host/schema';
import { initializeTheme } from './theme';
import { App } from './app/App';

initializeTheme();

const container = document.getElementById('root')!;
const root = createRoot(container);

function fatal(message: string): void {
  root.render(<div className="flex h-full items-center justify-center p-8 text-sm text-nim-muted" role="alert">{message}</div>);
}

async function boot(): Promise<void> {
  const info = await wikiApi.info();
  if (info.apiVersion !== WIKI_API_VERSION) {
    fatal(`This browser app speaks wiki API ${WIKI_API_VERSION} and nim ${info.version} speaks ${info.apiVersion}. Install the matching @nimbalyst/wiki-web.`);
    return;
  }
  const [types, module] = await Promise.all([wikiApi.types(), loadTrackerPage()]);
  await loadWikiSchema(types);
  const trackers = new LocalTrackerDataSource(info.root, types);
  root.render(<App root={info.root} trackers={trackers} module={module} />);
}

boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  fatal(/401|unauthorized/i.test(message) ? 'Open the link `nim wiki serve` printed; it carries the access token.' : `The wiki could not load: ${message}`);
});
