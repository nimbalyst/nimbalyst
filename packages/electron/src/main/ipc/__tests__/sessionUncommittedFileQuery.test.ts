// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadBetterSqlite, nativeBindingOverride } from '../../database/sqlite/betterSqliteLoader';
import { PGlite } from '@electric-sql/pglite';
import { sessionUncommittedFileQuery } from '../sessionUncommittedFileQuery';
import { translateAndBind } from '../../database/sqlite/dialectTranslator';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';

const Database = loadBetterSqlite();
const sqliteOptions = nativeBindingOverride() ? { nativeBinding: nativeBindingOverride() } : {};

const workspace = 'C:/fixture';
const special = "\u05e2\u05d1\u05e8\u05d9\u05ea/quote'file.txt";
const records = [
    ['old', workspace, special, 'edited', 1],
    ['latest', workspace, special, 'edited', 2],
    ['absolute', workspace, `${workspace}/last.txt`, 'edited', 3],
    ['foreign', 'other', special, 'edited', 4],
    ['reader', workspace, special, 'read', 5],
    ['unrelated', workspace, 'clean.txt', 'edited', 6],
];
const ddl = 'CREATE TABLE session_files (session_id TEXT, workspace_id TEXT, file_path TEXT, link_type TEXT, timestamp INTEGER)';

describe('uncommitted-file query', () => {
    it.each(['sqlite', 'pglite'] as const)('round-trips JSON-sensitive/non-BMP paths and duplicate candidates on %s', async engine => {
        const tricky = 'folder/double"back\\slash-\u{1f600}.md';
        const absolute = `${workspace}/${tricky}`;
        const query = sessionUncommittedFileQuery(workspace, new Set([tricky, absolute]), engine);
        const small = sessionUncommittedFileQuery(workspace, new Set([tricky]), engine);
        expect(query.sql).toBe(small.sql);
        const rows = [['old', workspace, tricky, 'edited', 1], ['latest', workspace, tricky, 'edited', 2], ['absolute', workspace, absolute, 'edited', 3]];
        const expected = [{ session_id: 'latest', file_path: tricky }, { session_id: 'absolute', file_path: absolute }];
        if (engine === 'sqlite') {
            const db = new Database(':memory:', sqliteOptions);
            try {
                db.exec(ddl);
                const insert = db.prepare('INSERT INTO session_files VALUES (?, ?, ?, ?, ?)');
                rows.forEach(row => insert.run(...row));
                const adapted = translateAndBind(query.sql, query.params);
                expect(Object.keys(adapted.binds)).toHaveLength(2);
                expect(db.prepare(adapted.sql).all(adapted.binds)).toEqual(expect.arrayContaining(expected));
                expect(db.prepare(adapted.sql).all(adapted.binds)).toHaveLength(2);
            } finally { db.close(); }
        } else {
            const db = new PGlite();
            try {
                await db.exec(ddl);
                for (const row of rows) await db.query('INSERT INTO session_files VALUES ($1,$2,$3,$4,$5)', row);
                const result = await db.query(query.sql, query.params);
                expect(result.rows).toEqual(expect.arrayContaining(expected));
                expect(result.rows).toHaveLength(2);
            } finally { await db.close(); }
        }
    });
    it.each([
        ['sqlite', 'D:\\fixture with spaces'],
        ['pglite', 'D:\\fixture with spaces'],
        ['sqlite', '\\\\server\\share'],
        ['pglite', '\\\\server\\share'],
    ] as const)('matches Windows provider paths on %s at %s', async (engine, workspacePath) => {
        const storedPath = `${workspacePath}\\.qa-sql\\provider-proof.md`;
        const rows = [
            ['old', workspacePath, storedPath, 'edited', 1],
            ['latest', workspacePath, storedPath, 'edited', 2],
            ['foreign', 'other', storedPath, 'edited', 3],
            ['reader', workspacePath, storedPath, 'read', 4],
        ];
        const query = sessionUncommittedFileQuery(workspacePath, new Set(['.qa-sql/provider-proof.md']), engine);
        const expected = [{ session_id: 'latest', file_path: storedPath }];
        if (engine === 'sqlite') {
            const db = new Database(':memory:', sqliteOptions);
            try {
                db.exec(ddl);
                const insert = db.prepare('INSERT INTO session_files VALUES (?, ?, ?, ?, ?)');
                for (const row of rows) insert.run(...row);
                const translated = translateAndBind(query.sql, query.params);
                expect(Object.keys(translated.binds)).toHaveLength(2);
                expect(db.prepare(translated.sql).all(translated.binds)).toEqual(expected);
            } finally { db.close(); }
        } else {
            const db = new PGlite();
            try {
                await db.exec(ddl);
                for (const row of rows) await db.query('INSERT INTO session_files VALUES ($1, $2, $3, $4, $5)', row);
                expect((await db.query(query.sql, query.params)).rows).toEqual(expected);
            } finally { await db.close(); }
        }
    });

    it('uses the real SQLite adapter and the existing current-schema lookup index', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'nim-membership-plan-'));
        const db = new SQLiteDatabase({ dbDir: dir, schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'), sampleRate: 0 });
        try {
            await db.initialize();
            for (const [i, row] of records.entries()) {
                await db.query('INSERT INTO session_files (id, session_id, workspace_id, file_path, link_type, timestamp) VALUES ($1,$2,$3,$4,$5,$6)', [`fixture-${i}`, ...row]);
            }
            const query = sessionUncommittedFileQuery(workspace, new Set([special, 'last.txt']), 'sqlite');
            const result = await db.query(query.sql, query.params);
            expect(result.rows).toHaveLength(2);
            expect(result.rows).toEqual(expect.arrayContaining([
                { session_id: 'latest', file_path: special },
                { session_id: 'absolute', file_path: `${workspace}/last.txt` },
            ]));
            const plan = await db.query<{ detail: string }>('EXPLAIN QUERY PLAN ' + query.sql, query.params);
            expect(plan.rows.some(row => row.detail.includes('SEARCH session_files USING INDEX idx_session_files_uncommitted_lookup'))).toBe(true);
            expect(plan.rows.some(row => /SCAN session_files\b/.test(row.detail))).toBe(false);
        } finally {
            await db.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('handles 41,288 dirty paths with two SQLite binds and preserves attribution', () => {
        const db = new Database(':memory:', sqliteOptions);
        try {
            db.exec(ddl);
            const insert = db.prepare('INSERT INTO session_files VALUES (?, ?, ?, ?, ?)');
            for (const record of records) insert.run(...record);
            const paths = new Set(Array.from({ length: 41_286 }, (_, i) => `scratch/${i}.txt`));
            paths.add(special);
            paths.add('last.txt');
            const query = sessionUncommittedFileQuery(workspace, paths, 'sqlite');
            const translated = translateAndBind(query.sql, query.params);
            expect(Object.keys(translated.binds)).toHaveLength(2);
            expect(db.prepare(translated.sql).all(translated.binds)).toEqual(expect.arrayContaining([
                { session_id: 'latest', file_path: special },
                { session_id: 'absolute', file_path: `${workspace}/last.txt` },
            ]));
            expect(db.prepare(translated.sql).all(translated.binds)).toHaveLength(2);
            const empty = sessionUncommittedFileQuery(workspace, new Set(), 'sqlite');
            const adaptedEmpty = translateAndBind(empty.sql, empty.params);
            expect(db.prepare(adaptedEmpty.sql).all(adaptedEmpty.binds)).toEqual([]);
        } finally {
            db.close();
        }
    });

    it('preserves PostgreSQL array matching and latest-editor semantics on PGLite', async () => {
        const db = new PGlite();
        try {
            await db.exec(ddl);
            for (const record of records) {
                await db.query('INSERT INTO session_files VALUES ($1, $2, $3, $4, $5)', record);
            }
            const query = sessionUncommittedFileQuery(workspace, new Set([special, 'last.txt']), 'pglite');
            const result = await db.query(query.sql, query.params);
            expect(result.rows).toHaveLength(2);
            expect(result.rows).toEqual(expect.arrayContaining([
                { session_id: 'latest', file_path: special },
                { session_id: 'absolute', file_path: `${workspace}/last.txt` },
            ]));
            const empty = sessionUncommittedFileQuery(workspace, new Set(), 'pglite');
            expect((await db.query(empty.sql, empty.params)).rows).toEqual([]);
        } finally {
            await db.close();
        }
    });
});
