import { appendFile, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { idForFileName, ulid } from './ids.js';
import { composeMarkdownFile, parseMarkdownFile, RESERVED_KEYS } from './frontmatter.js';
import { fileStemForTitle, nameKey, uniqueStem } from './names.js';
import { stringifyCsv } from './csv.js';
import { atomicWrite, movePath, pathExists, relJoin, writeExclusive } from './fsutil.js';
import { ACTIVITY_SUFFIX, MARKER_FILE, TRASH_DIR, type TableRecord, type TrashManifest } from './scan.js';
import type { WikiTypeDef } from './typeDefs.js';
import { decodeRow, encodeRow, tableHeader } from './tableCodec.js';
import { ORDER_STEP } from './project.js';
import type { ActivityEntry, LocalTrackerCommand, LocalWikiCommandResult } from './types.js';
import { LocalWikiError, MARKER_HEADER, WikiCore } from './core.js';

/** Table types: one CSV per type. */
export class WikiTables extends WikiCore {
  /**
   * Splits a table type's CSV into one page per row, in the CSV's folder.
   * Every page is written and read back before the CSV goes to trash; the type
   * YAML's `storage: table` line is then changed to `storage: pages`.
   */
  async convertTableToPages(typeId: string): Promise<{ created: string[]; typeFileUpdated: boolean }> {
    return this.mutate(async () => {
      const def = this.types.get(typeId);
      const table = this.state.tables.get(typeId);
      if (!def || def.storage !== 'table' || !table) throw new LocalWikiError('not-a-table', `${typeId} has no table in this wiki`);
      const { header, rows } = await this.readTableRows(table);
      const parentId = this.state.byDir.get(nameKey(table.parentDir)) ?? null;
      const occupied = await this.occupiedNames(table.parentDir, null);
      let order = this.nextOrder(table.parentDir);
      const created: Array<{ id: string; rel: string; fields: Record<string, unknown> }> = [];
      for (const row of rows) {
        const { id, fields } = decodeRow(header, row, def);
        const title = String(fields[def.titleField] ?? '') || id;
        delete fields[def.titleField];
        const stem = uniqueStem(fileStemForTitle(title), occupied);
        occupied.add(nameKey(stem));
        const rel = relJoin(table.parentDir, `${stem}.md`);
        const data = { id, ...(title !== stem ? { title } : {}), type: typeId, order, ...fields };
        await atomicWrite(this.abs(rel), composeMarkdownFile(data, ''));
        created.push({ id, rel, fields });
        order += ORDER_STEP;
      }
      for (const page of created) {
        const back = parseMarkdownFile(await readFile(this.abs(page.rel), 'utf8'));
        const ok = back.ok && back.data.id === page.id && JSON.stringify(Object.fromEntries(Object.entries(back.data).filter(([k]) => !RESERVED_KEYS.includes(k as never)))) === JSON.stringify(page.fields);
        if (!ok) throw new LocalWikiError('invalid', `Converted page ${page.rel} did not read back as written; the CSV was left in place`);
      }
      // Activity: each row's lines move beside its new page.
      const activityRel = this.tableActivityPath(table);
      try {
        const lines = (await readFile(this.abs(activityRel), 'utf8')).split('\n').filter((l) => l.trim());
        for (const page of created) {
          const mine = lines.filter((line) => {
            try {
              return (JSON.parse(line) as ActivityEntry).itemId === page.id;
            } catch {
              return false;
            }
          });
          if (mine.length) await appendFile(this.abs(page.rel.slice(0, -3) + ACTIVITY_SUFFIX), mine.join('\n') + '\n');
        }
      } catch {
        // no activity yet
      }
      const trashedAt = this.now();
      const entryDir = relJoin(TRASH_DIR, `${trashedAt}-table-${typeId}`);
      const csvName = path.posix.basename(table.path);
      const activityName = path.posix.basename(activityRel);
      const hasActivity = await pathExists(this.abs(activityRel));
      await this.writeTrashManifest(entryDir, {
        formatVersion: 1,
        kind: 'table',
        id: `table:${typeId}`,
        title: def.displayNamePlural,
        trashedAt,
        originalParentId: parentId,
        originalDir: table.parentDir,
        typeId,
        entries: { csv: csvName, ...(hasActivity ? { activity: activityName } : {}) },
      });
      await movePath(this.abs(table.path), this.abs(relJoin(entryDir, csvName)));
      if (hasActivity) await movePath(this.abs(activityRel), this.abs(relJoin(entryDir, activityName)));
      let typeFileUpdated = false;
      const yamlText = await readFile(def.sourcePath, 'utf8');
      const updated = yamlText.replace(/^storage:[ \t]*['"]?table['"]?[ \t]*$/m, 'storage: pages');
      if (updated !== yamlText) {
        await atomicWrite(def.sourcePath, updated);
        typeFileUpdated = true;
      }
      await this.refresh();
      return { created: created.map((c) => c.id), typeFileUpdated };
    });
  }

  protected csvFileName(def: WikiTypeDef): string {
    return `${fileStemForTitle(def.displayNamePlural)}.csv`;
  }

  /**
   * The type's table, created empty at the wiki root when it has none. The
   * create is exclusive: a CSV another writer made since the last scan is
   * read and used, never replaced.
   */
  protected async ensureTable(def: WikiTypeDef): Promise<TableRecord> {
    const existing = this.state.tables.get(def.typeId);
    if (existing) return existing;
    await writeExclusive(this.abs(this.csvFileName(def)), stringifyCsv([tableHeader([], def)]));
    await this.scan(false);
    const table = this.state.tables.get(def.typeId);
    if (!table) throw new LocalWikiError('exists', `${this.csvFileName(def)} exists but is not readable as the ${def.typeId} table`);
    return table;
  }

  protected async writeTable(table: TableRecord, header: string[], rows: string[][]): Promise<void> {
    await atomicWrite(this.abs(table.path), stringifyCsv([header, ...rows]));
  }

  protected async tableCommand(def: WikiTypeDef, cmd: LocalTrackerCommand): Promise<LocalWikiCommandResult> {
    const table = await this.ensureTable(def);
    const current = await this.readTableRows(table);
    const header = tableHeader(current.header, def);
    const rows = current.rows.map((row) => {
      const padded = [...row];
      while (padded.length < header.length) padded.push('');
      return padded;
    });
    const activity = this.tableActivityPath(table);
    const withColumns = (fields: Record<string, unknown>) => {
      for (const key of Object.keys(fields)) {
        if (!header.includes(key) && key !== 'id') {
          header.push(key);
          for (const row of rows) row.push('');
        }
      }
    };
    switch (cmd.type) {
      case 'create-item': {
        const id = cmd.item.id ?? ulid(this.now());
        this.requireSafeId(id);
        if (rows.some((row) => row[0].trim() === id)) throw new LocalWikiError('exists', `Row ${id} exists`);
        const fields = { ...(cmd.item.fields ?? {}), [def.titleField]: cmd.item.title };
        withColumns(fields);
        rows.push(encodeRow(header, id, fields, def));
        await this.writeTable(table, header, rows);
        await this.appendActivity(activity, { itemId: id, action: 'create' });
        await this.refresh();
        return { ok: true, id };
      }
      case 'update-item': {
        this.requireSafeId(cmd.input.itemId);
        const index = rows.findIndex((row) => row[0].trim() === cmd.input.itemId);
        if (index < 0) throw new LocalWikiError('not-found', `No row ${cmd.input.itemId}`);
        const { fields } = decodeRow(header, rows[index], def);
        const updates = { ...cmd.input.updates };
        if ('title' in updates && def.titleField !== 'title') {
          updates[def.titleField] = updates.title;
          delete updates.title;
        }
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const [key, value] of Object.entries(updates)) {
          if (key === 'id') throw new LocalWikiError('invalid', 'id is not a field');
          const from = fields[key];
          if (value === null || value === undefined) delete fields[key];
          else fields[key] = value;
          if (JSON.stringify(from) !== JSON.stringify(fields[key])) changes[key] = { from: from ?? null, to: fields[key] ?? null };
        }
        withColumns(fields);
        rows[index] = encodeRow(header, cmd.input.itemId, fields, def);
        await this.writeTable(table, header, rows);
        if (Object.keys(changes).length > 0) await this.appendActivity(activity, { itemId: cmd.input.itemId, action: 'update', changes });
        await this.refresh();
        return { ok: true, id: cmd.input.itemId };
      }
      case 'delete-item': {
        this.requireSafeId(cmd.itemId);
        const index = rows.findIndex((row) => row[0].trim() === cmd.itemId);
        if (index < 0) throw new LocalWikiError('not-found', `No row ${cmd.itemId}`);
        const trashedAt = this.now();
        const row = Object.fromEntries(header.map((column, i) => [column, rows[index][i] ?? '']));
        await this.writeTrashManifest(relJoin(TRASH_DIR, `${trashedAt}-${idForFileName(cmd.itemId)}`), {
          formatVersion: 1,
          kind: 'row',
          id: cmd.itemId,
          title: String(decodeRow(header, rows[index], def).fields[def.titleField] ?? cmd.itemId),
          trashedAt,
          originalParentId: this.state.byDir.get(nameKey(table.parentDir)) ?? null,
          originalDir: table.parentDir,
          typeId: def.typeId,
          row,
        });
        rows.splice(index, 1);
        await this.writeTable(table, header, rows);
        await this.appendActivity(activity, { itemId: cmd.itemId, action: 'trash' });
        await this.refresh();
        return { ok: true, id: cmd.itemId };
      }
    }
  }

  protected async restoreRow(manifest: TrashManifest): Promise<void> {
    const def = manifest.typeId ? this.types.get(manifest.typeId) : undefined;
    if (!def || def.storage !== 'table' || !manifest.row) throw new LocalWikiError('invalid', `Cannot restore row ${manifest.id}: its type is no longer a table`);
    const table = await this.ensureTable(def);
    const current = await this.readTableRows(table);
    const header = tableHeader(current.header, def);
    for (const column of Object.keys(manifest.row)) if (!header.includes(column)) header.push(column);
    const rows = current.rows.map((row) => header.map((_, i) => row[i] ?? ''));
    if (rows.some((row) => row[0].trim() === manifest.id)) throw new LocalWikiError('exists', `Row ${manifest.id} already exists`);
    rows.push(header.map((column) => manifest.row![column] ?? ''));
    await this.writeTable(table, header, rows);
    await this.appendActivity(this.tableActivityPath(table), { itemId: manifest.id, action: 'restore' });
  }

  protected async placeTable(typeId: string, parentId: string | null, sortOrder: number): Promise<void> {
    const def = this.types.get(typeId);
    if (!def || def.storage !== 'table') throw new LocalWikiError('not-a-table', `${typeId} is not a table type`);
    const parent = parentId ? this.requireLivePage(parentId) : null;
    const targetDir = parent?.dir ?? '';
    const table = this.state.tables.get(typeId);
    if (table) {
      if (nameKey(table.parentDir) !== nameKey(targetDir)) {
        const name = path.posix.basename(table.path);
        const target = relJoin(targetDir, name);
        if (await pathExists(this.abs(target))) throw new LocalWikiError('exists', `${target} already exists`);
        const activity = this.tableActivityPath(table);
        await movePath(this.abs(table.path), this.abs(target));
        if (await pathExists(this.abs(activity))) await movePath(this.abs(activity), this.abs(target.slice(0, -4) + ACTIVITY_SUFFIX));
      }
    } else {
      await writeExclusive(this.abs(relJoin(targetDir, this.csvFileName(def))), stringifyCsv([tableHeader([], def)]));
    }
    this.marker = { ...this.marker, tables: { ...(this.marker.tables ?? {}), [typeId]: { order: sortOrder } } };
    await atomicWrite(path.join(this.root, MARKER_FILE), MARKER_HEADER + yaml.dump(this.marker, { schema: yaml.CORE_SCHEMA }));
    await this.refresh();
  }
}
