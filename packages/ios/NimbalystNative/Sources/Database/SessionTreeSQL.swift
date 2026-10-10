import Foundation

/// Shared by the live queries and the persisted projection. Manager links never
/// decide position: an isolated session may have a manager in another container.
enum SessionTreeSQL {
    static func groupKey(visible: (String) -> String) -> String {
        """
        CASE WHEN b.worktreeId IS NOT NULL THEN 'wt:' || b.worktreeId
        ELSE (
            WITH RECURSIVE ancestors(id, parentSessionId, sessionType) AS (
                SELECT b.id, b.parentSessionId, b.sessionType
                UNION
                SELECT p.id, p.parentSessionId, p.sessionType
                -- CROSS JOIN pins the order: left to the planner, each step scanned
                -- the project index, making every group key O(project).
                FROM ancestors a CROSS JOIN sessions p ON p.id = a.parentSessionId
                WHERE \(visible("p")) AND p.worktreeId IS b.worktreeId
                  AND COALESCE(a.sessionType, '') NOT IN ('workstream', 'blitz')
            )
            SELECT CASE WHEN r.sessionType = 'workstream' OR r.id <> b.id
                OR EXISTS (SELECT 1 FROM sessions c INDEXED BY idx_sessions_parent WHERE c.parentSessionId = r.id
                           AND c.id <> r.id AND c.worktreeId IS b.worktreeId AND \(visible("c")))
                THEN 'ws:' ELSE 's:' END || r.id
            FROM ancestors r
            -- Broken cycles choose the same stable anchor from every member.
            ORDER BY CASE WHEN COALESCE(r.sessionType, '') IN ('workstream', 'blitz')
                OR NOT EXISTS (SELECT 1 FROM ancestors p WHERE p.id = r.parentSessionId)
                THEN 0 ELSE 1 END, r.id
            LIMIT 1
        ) END
        """
    }

    /// Preorder keyset paging keeps a parent ahead of its descendants even when
    /// the grandchild is the newest row. Work is bounded by this expanded group.
    static func childrenQuery(prefix: String, members: String) -> String {
        """
        WITH RECURSIVE \(prefix)
        nodes AS MATERIALIZED (\(members)),
        descendants(ancestor, id) AS (
            SELECT id, id FROM nodes
            UNION
            SELECT d.ancestor, c.id FROM descendants d JOIN nodes c ON c.parentSessionId = d.id
        ),
        ranked AS MATERIALIZED (
            SELECT n.*, ROW_NUMBER() OVER (ORDER BY n.isPinned DESC,
                (SELECT MAX(c.updatedAt) FROM descendants d JOIN nodes c ON c.id = d.id
                 WHERE d.ancestor = n.id) DESC, n.id DESC) AS siblingOrder
            FROM nodes n
        ),
        tree(id, depth, treeOrder, visited) AS (
            SELECT n.id, CASE WHEN :groupKey LIKE 'wt:%' THEN 0 ELSE 1 END,
                   printf('%012d', n.siblingOrder), '|' || n.id || '|'
            FROM ranked n WHERE NOT EXISTS (SELECT 1 FROM nodes p WHERE p.id = n.parentSessionId)
            UNION ALL
            SELECT c.id, p.depth + 1, p.treeOrder || '.' || printf('%012d', c.siblingOrder),
                   p.visited || c.id || '|'
            FROM ranked c JOIN tree p ON c.parentSessionId = p.id
            WHERE instr(p.visited, '|' || c.id || '|') = 0
        ),
        ordered AS (
            SELECT n.*, COALESCE(t.depth, 0) AS treeDepth,
                   COALESCE(t.treeOrder, 'z' || printf('%012d', n.siblingOrder)) AS treeOrder
            FROM ranked n LEFT JOIN tree t ON t.id = n.id
        )
        SELECT * FROM ordered
        WHERE :afterTreeOrder IS NULL OR treeOrder > :afterTreeOrder
        ORDER BY treeOrder
        LIMIT :limit
        """
    }

    static func childPage(_ rows: [SessionListRow], limit: Int) -> SessionListChildPage {
        let page = Array(rows.prefix(limit))
        return SessionListChildPage(rows: page, nextCursor: rows.count > limit
            ? page.last.map { SessionListChildCursor(updatedAt: $0.updatedAt, id: $0.id, treeOrder: $0.treeOrder) }
            : nil)
    }

    /// SQLite triggers cannot start a statement with WITH; nest the recursive
    /// walk in the INSERT's SELECT instead. UNION also terminates corrupt cycles.
    static func dirtyAncestors(_ id: String) -> String {
        """
        INSERT OR REPLACE INTO sessionListGroupDirty(sessionId, projectId)
        SELECT id, projectId FROM (
            WITH RECURSIVE ancestors(id, projectId, parentSessionId) AS (
                SELECT id, projectId, parentSessionId FROM sessions WHERE id = \(id)
                UNION
                SELECT p.id, p.projectId, p.parentSessionId FROM ancestors a
                CROSS JOIN sessions p ON p.id = a.parentSessionId AND p.projectId = a.projectId
            ) SELECT id, projectId FROM ancestors
        );
        """
    }

    static func dirtyDescendants(_ id: String) -> String {
        """
        INSERT OR REPLACE INTO sessionListGroupDirty(sessionId, projectId)
        SELECT id, projectId FROM (
            WITH RECURSIVE descendants(id, projectId) AS (
                SELECT id, projectId FROM sessions WHERE parentSessionId = \(id)
                UNION
                SELECT c.id, c.projectId FROM descendants p
                CROSS JOIN sessions c ON c.parentSessionId = p.id AND c.projectId = p.projectId
            ) SELECT id, projectId FROM descendants
        );
        """
    }
}
