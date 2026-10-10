// Tracker body seeding carries the Markdown/Lexical codec, so it is its own
// subpath: the collab-bundle `./editor` entry re-exports it, and hosts inject
// it into `BrowserTrackerDataSource` rather than `trackers-ui` importing it.
export { seedTrackerBody } from '../browser/seedTrackerBody';
export { trackerBodyDocumentId } from '../browser/trackerBodyRoom';
export type { TrackerBodyRoom, TrackerBodySeeder } from '../browser/trackerBodyRoom';
export { openBrowserDocumentRoom, readDocumentRoomMarkdown, type BrowserDocumentRoomOptions } from '../browser/documentRoom';
