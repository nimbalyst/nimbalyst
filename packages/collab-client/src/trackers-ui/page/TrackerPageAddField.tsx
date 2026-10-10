/**
 * The "+" at the end of a typed page's type row. It moved to the runtime with
 * the row itself (`TrackerTypeRow`), so Files and Pages share one; this name
 * stays for existing imports.
 */
export {
  TrackerAddFieldMenu as TrackerPageAddField,
  type TrackerAddFieldMenuProps as TrackerPageAddFieldProps,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/components/TrackerTypeRow';
