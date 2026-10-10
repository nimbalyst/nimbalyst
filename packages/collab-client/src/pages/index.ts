/**
 * Knowledge pages: contracts shared by the desktop and the web console.
 * Logic only -- no React.
 */

export {
  filterPageMarks,
  getPageMarksSource,
  mergePageMarks,
  onPageMarksSourceChange,
  pageMarkRecordsFromTeamIndex,
  PageMarksChangeFeed,
  setPageMarksSource,
} from './pageMarks';
export type {
  TeamIndexMappingOptions,
  PageMarkKind,
  PageMarkPageKind,
  PageMarkRecord,
  PageMarksQuery,
  PageMarksSource,
} from './pageMarks';
