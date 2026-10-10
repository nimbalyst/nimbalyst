/**
 * How a cell edit in a view embed reaches the item: one `update-items` command
 * through the host's data source, so a placed view and a type page's table
 * write the way the rest of the host does. The host routes each entry (a
 * file-backed item's fields to its file on desktop, the team lane in the
 * browser); this module only decides what may be edited and what to send.
 */
import type { TrackerRecord } from '../../../../runtime/src/core/TrackerRecord';
import type { TrackerDataCommand, TrackerDataSource } from '../../trackers/index';
import type { TrackerGridUpdateEntry } from '../grid/TrackerGridSurface';
/** The table's own rule (`useTrackerRows`): an archived type is read-only; other sources' fields are written where they live. */
export declare function isViewRecordEditable(record: TrackerRecord): boolean;
export declare function viewEditsCommand(entries: readonly TrackerGridUpdateEntry[]): TrackerDataCommand;
/** Throws when the host refused, so the grid shows the reason instead of a saved-looking cell. */
export declare function writeViewEdits(dataSource: Pick<TrackerDataSource, 'command'>, entries: readonly TrackerGridUpdateEntry[]): Promise<void>;
