import type { PlacedViewSettingsProps } from './PlacedViewSettings';
export type ViewSettingsSection = 'layout' | 'properties' | 'filter' | 'sort' | 'group';
export declare const VIEW_LAYOUTS: {
    value: string;
    label: string;
    icon: string;
}[];
export declare const SETTINGS_INPUT = "min-w-0 rounded border border-nim bg-nim-secondary px-2 py-1.5 text-xs text-nim";
export declare function PlacedViewSettingsSection({ section, attrs, fields, availableColumns, defaultColumns, onChange }: PlacedViewSettingsProps & {
    section: ViewSettingsSection;
}): import("react").JSX.Element;
