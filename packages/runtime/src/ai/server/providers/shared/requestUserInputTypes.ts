/**
 * RequestUserInput tool: shared schema.
 *
 * One MCP tool, one widget, multiple typed fields. The agent composes a prompt
 * out of any of the field types below; the widget renders each field with the
 * matching sub-renderer; the answer payload returns a typed Answer per field id.
 */

export interface RequestUserInputBaseField {
  /** Stable key the agent uses to find this field's answer in the result. */
  id: string;
  /** Short label shown above the control. */
  label: string;
  /** Optional longer explanation; voice-readable. */
  description?: string;
}

export interface RequestUserInputMultiSelectItem {
  id: string;
  title: string;
  subtitle?: string;
  badge?: string;
  defaultChecked?: boolean;
}

export interface RequestUserInputMultiSelectField extends RequestUserInputBaseField {
  type: 'multiSelect';
  items: RequestUserInputMultiSelectItem[];
  /** Default 0. */
  minSelected?: number;
  /** Default = items.length. */
  maxSelected?: number;
}

export interface RequestUserInputSingleSelectOption {
  id: string;
  label: string;
  description?: string;
}

export interface RequestUserInputSingleSelectField extends RequestUserInputBaseField {
  type: 'singleSelect';
  options: RequestUserInputSingleSelectOption[];
  /** Show an "Other" textarea fallback. */
  allowOther?: boolean;
}

export interface RequestUserInputReorderItem {
  id: string;
  title: string;
  subtitle?: string;
  /** When true, the row shows a delete affordance. */
  removable?: boolean;
}

export interface RequestUserInputReorderField extends RequestUserInputBaseField {
  type: 'reorder';
  items: RequestUserInputReorderItem[];
  /** Floor when items are removable. Default 0. */
  minItems?: number;
}

export interface RequestUserInputEditTextField extends RequestUserInputBaseField {
  type: 'editText';
  /** Initial text the agent provides as markdown or plain text. */
  initialText: string;
  /** Drives Lexical render. Default 'markdown'. */
  format?: 'markdown' | 'plain';
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
}

export interface RequestUserInputConfirmField extends RequestUserInputBaseField {
  type: 'confirm';
  defaultValue?: boolean;
}

export type RequestUserInputField =
  | RequestUserInputMultiSelectField
  | RequestUserInputSingleSelectField
  | RequestUserInputReorderField
  | RequestUserInputEditTextField
  | RequestUserInputConfirmField;

export interface RequestUserInputArgs {
  /** Overall prompt title shown in the widget header. */
  title?: string;
  /** One- or two-sentence context paragraph above the fields. */
  intro?: string;
  /** One or more fields composed in a single prompt. */
  fields: RequestUserInputField[];
  /** Default "Confirm". */
  submitLabel?: string;
  /** Default "Cancel". */
  cancelLabel?: string;
}

export type RequestUserInputAnswer =
  | { type: 'multiSelect'; selectedIds: string[] }
  | { type: 'singleSelect'; selectedId: string; otherText?: string }
  | { type: 'reorder'; orderedIds: string[]; removedIds: string[] }
  | { type: 'editText'; text: string; edited: boolean }
  | { type: 'confirm'; value: boolean };

export interface RequestUserInputResult {
  cancelled?: boolean;
  /** Map keyed by field.id. */
  answers: Record<string, RequestUserInputAnswer>;
}
