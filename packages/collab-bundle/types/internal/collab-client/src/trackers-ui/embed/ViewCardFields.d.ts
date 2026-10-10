import type { TrackerRecord } from '../../../../runtime/src/core/TrackerRecord';
import type { TrackerRelationshipLabelResolver } from '../../../../runtime/src/plugins/TrackerPlugin/models/index';
/** The same field labels and values as a table, in the order chosen for this view. */
export declare function ViewCardFields({ item, columns, resolveLabel }: {
    item: TrackerRecord;
    columns: readonly string[];
    resolveLabel?: TrackerRelationshipLabelResolver;
}): import("react").JSX.Element;
