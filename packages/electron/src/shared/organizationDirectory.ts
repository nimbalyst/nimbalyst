export interface OrganizationDirectoryEntry {
  orgId: string;
  name: string;
  role: string;
  membershipType?: string;
  sourcePersonalOrgId?: string;
  owningPersonalOrgId?: string | null;
  sourceEmail?: string | null;
  /** Project registry for the org; absent on snapshots from older workers. */
  projects?: Array<{ projectId: string; name: string | null; slug: string | null }>;
  /** Every signed-in account that resolved a membership in this org. */
  accountBindings?: Array<{ personalOrgId: string; teamMemberId: string }>;
  /** Account chosen from the explicit local binding — the one whose JWT this org uses. */
  boundPersonalOrgId?: string | null;
}

/** A failed enumeration is never evidence of an empty organization directory. */
export type OrganizationDirectoryResult =
  | { success: true; complete: true; teams: OrganizationDirectoryEntry[] }
  | { success: false; complete: false; teams: OrganizationDirectoryEntry[]; error: string; retryable: boolean };

export interface OrganizationDirectorySnapshot {
  entries: OrganizationDirectoryEntry[];
  status: 'loading' | 'ready' | 'error' | 'signed-out';
  complete: boolean;
  error?: string;
}
