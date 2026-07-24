/**
 * The renderer's codec registry -- the authoritative one.
 *
 * The registry is process-local, so each process populates its own. The
 * renderer's is the complete one: it gets the in-repo codecs registered here
 * PLUS every marketplace codec an extension donates from `activate()` via
 * `context.services.collab.registerContentAdapter(...)`. That is what makes
 * the renderer a *codec host* the main process can delegate conversion to.
 *
 * The in-repo set is registered statically rather than waiting for the bundled
 * extensions to activate, so a headless caller (the pre-migration backup
 * sweep) sees the same coverage the main process has today regardless of which
 * editors the user has opened this session. Extension registrations layer on
 * top -- last registration wins, so an activated extension supersedes its
 * static twin.
 *
 * See `nimbalyst-local/plans/collab-conversion-off-main.md`.
 */
import { registerCollabContentAdapter } from '@nimbalyst/collab-adapters';
import { MarkdownCollabContentAdapter } from '@nimbalyst/runtime/collab-lexical';
import { CalcSheetCollabContentAdapter } from '@nimbalyst/extension-calc-sheets/collab-adapter';
import { CsvCollabContentAdapter } from '@nimbalyst/extension-csv-spreadsheet/collab-adapter';
import { ExcalidrawCollabContentAdapter } from '@nimbalyst/excalidraw-extension/collab-adapter';
import { DataModelCollabContentAdapter } from '@nimbalyst/extension-datamodellm/collab-adapter';
import {
  MockupHtmlCollabContentAdapter,
  MockupProjectCollabContentAdapter,
} from '@nimbalyst/mockuplm/collab-adapters';

import { CodeCollabContentAdapter } from '../utils/CodeCollabContentAdapter';

let registered = false;

export function registerBuiltinRendererCollabCodecs(): void {
  if (registered) return;
  registered = true;
  registerCollabContentAdapter(MarkdownCollabContentAdapter);
  registerCollabContentAdapter(CodeCollabContentAdapter);
  registerCollabContentAdapter(CalcSheetCollabContentAdapter);
  registerCollabContentAdapter(CsvCollabContentAdapter);
  registerCollabContentAdapter(ExcalidrawCollabContentAdapter);
  registerCollabContentAdapter(DataModelCollabContentAdapter);
  registerCollabContentAdapter(MockupHtmlCollabContentAdapter);
  registerCollabContentAdapter(MockupProjectCollabContentAdapter);
}
