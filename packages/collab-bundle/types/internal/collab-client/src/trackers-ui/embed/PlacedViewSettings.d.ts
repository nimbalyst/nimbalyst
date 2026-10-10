import type { TrackerColumnDef } from '../../../../runtime/src/plugins/TrackerPlugin/components/trackerColumns';
import type { TrackerFilterField } from '../trackerFilterFields';
export interface PlacedViewSettingsProps {
    attrs: Readonly<Record<string, string>>;
    fields: readonly TrackerFilterField[];
    availableColumns: TrackerColumnDef[];
    temporary: boolean;
    defaultColumns?: readonly string[];
    onChange(patch: Readonly<Record<string, string | null>>): void;
}
/** A compact index of settings; each section edits only its own view attributes. */
export declare function PlacedViewSettings(props: PlacedViewSettingsProps): import("react").JSX.Element;
