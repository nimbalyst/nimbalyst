const REDACTED_PATH_PREFIX_LENGTH = 24;
const UUID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PATH_WITH_UUID_PATTERN = new RegExp(
  `(?:[a-z]:[\\\\/]|[\\\\/])[^\\s"'<>|]*${UUID_PATTERN}[^\\s"'<>|]*`,
  'gi',
);

export function redactPathsWithUuids(text: string): string {
  return text.replace(PATH_WITH_UUID_PATTERN, (pathLikeRun) => {
    return `${pathLikeRun.slice(0, REDACTED_PATH_PREFIX_LENGTH)}...[redacted]`;
  });
}
