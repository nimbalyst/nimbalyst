/** Latest edited session per stored path, compatible with both database engines. */
export function sessionUncommittedFileQuery(
    workspacePath: string,
    uncommittedFiles: Set<string>,
    engine: 'sqlite' | 'pglite',
): { sql: string; params: [string, string[] | string] } {
    const candidatePaths: string[] = [];
    for (const relativePath of uncommittedFiles) {
        const absolutePath = `${workspacePath}/${relativePath}`;
        candidatePaths.push(relativePath, absolutePath);
        // Git emits forward slashes; Windows provider edits store backslashes.
        if (/^[A-Za-z]:[\\/]|^\\\\/.test(workspacePath)) {
            candidatePaths.push(absolutePath.replace(/\//g, '\\'));
        }
    }
    // #1696: expanding ANY binds exceeds SQLite's limit in large dirty trees.
    const pathPredicate = engine === 'sqlite'
        ? 'file_path IN (SELECT value FROM json_each($2))'
        : 'file_path = ANY($2::text[])';
    return {
        sql: `SELECT session_id, file_path FROM (
               SELECT session_id, file_path,
                      ROW_NUMBER() OVER (PARTITION BY file_path ORDER BY timestamp DESC) AS rn
               FROM session_files
               WHERE workspace_id = $1
                 AND link_type = 'edited'
                 AND ${pathPredicate}
             ) ranked WHERE rn = 1`,
        params: [workspacePath, engine === 'sqlite' ? JSON.stringify(candidatePaths) : candidatePaths],
    };
}
