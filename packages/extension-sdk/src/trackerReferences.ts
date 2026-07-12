import type { ComponentType } from 'react';
import {
  TrackerReferenceChip as HostTrackerReferenceChip,
  TrackerReferencePicker as HostTrackerReferencePicker,
  navigateToTrackerReference as hostNavigateToTrackerReference,
  useResolvedTrackerReference as hostUseResolvedTrackerReference,
} from '@nimbalyst/runtime';

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

/** Host-provided live tracker reference chip. */
export const TrackerReferenceChip = HostTrackerReferenceChip as ComponentType<TrackerReferenceChipProps>;

/** Host-provided canonical tracker search and selection UI. */
export const TrackerReferencePicker = HostTrackerReferencePicker as ComponentType<TrackerReferencePickerProps>;

export const useResolvedTrackerReference = hostUseResolvedTrackerReference as (
  referenceKey: string,
) => ResolvedTrackerReference | null;

export const navigateToTrackerReference = hostNavigateToTrackerReference as (
  reference: ResolvedTrackerReference,
) => void;
