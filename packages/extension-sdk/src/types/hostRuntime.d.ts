declare module '@nimbalyst/runtime' {
  export function useDocumentPath(): {
    documentPath: string | null;
    documentDir: string | null;
  };

  export function MaterialSymbol(props: {
    icon: string;
    size?: number;
    fill?: boolean;
    weight?: number;
    grade?: number;
    opticalSize?: number;
    className?: string;
    title?: string;
    style?: import('react').CSSProperties;
  }): import('react').ReactElement | null;

  export interface ResolvedTrackerReference {
    id: string;
    issueKey?: string;
    title: string;
    status?: string;
    type?: string;
    priority?: string;
    owner?: string;
    updatedAt?: string;
  }

  export interface TrackerReferenceChipProps {
    referenceKey: string;
    nodeKey?: string;
    variant?: 'default' | 'compact';
  }

  export interface TrackerReferencePickerProps {
    value: readonly string[];
    onChange(value: string[]): void;
    multiple?: boolean;
    disabled?: boolean;
    placeholder?: string;
    className?: string;
    maxResults?: number;
  }

  export function TrackerReferenceChip(
    props: TrackerReferenceChipProps,
  ): import('react').ReactElement;
  export function TrackerReferencePicker(
    props: TrackerReferencePickerProps,
  ): import('react').ReactElement;
  export function useResolvedTrackerReference(
    referenceKey: string,
  ): ResolvedTrackerReference | null;
  export function navigateToTrackerReference(
    reference: ResolvedTrackerReference,
  ): void;
}
