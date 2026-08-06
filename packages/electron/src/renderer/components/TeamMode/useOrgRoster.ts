/**
 * The roster hook now lives in `renderer/hooks/useOrgRoster`, because the
 * organization's administration surfaces run in the project window too (org
 * management is a dialog as of NIM-2322) and nothing in the hook was ever
 * specific to this window. This re-export keeps the organization window's
 * modules importing it from where they always have.
 */
export {
  memberNamesById,
  resolveViewerMemberId,
  useOrgRoster,
  type OrgRoster,
  type OrgRosterMember,
} from '../../hooks/useOrgRoster';
