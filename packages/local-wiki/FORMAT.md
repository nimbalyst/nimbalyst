# Nimbalyst local wiki format, version 1

A local wiki is a folder of ordinary files. The desktop app, `nim`, `nim mcp` and `nim wiki serve` all read and write it through `@nimbalyst/local-wiki`, but nothing here needs that library: a person, a text editor, git or an agent can read and edit the files directly. This document is the contract. Files written by any version of the format must keep loading in later versions.

## Root

The wiki root is the folder that holds `.nimbalyst-wiki.yaml`:

```yaml
formatVersion: 1
tables:
  partner:
    order: 2000
```

- `formatVersion` is required. A reader that sees a higher version than it knows refuses to open the wiki instead of guessing.
- `tables` is optional and holds the position of each table type among its siblings (see Order). Unknown keys are preserved.

Names starting with `.` and `node_modules` are not part of the tree at any level; the one exception is an editor page's sidecar (`.<file>.wiki.yaml`, see Editor pages), which is read with its file. `.trash/` at the root holds deleted items, and `.nimbalyst-wiki.lock` is the write lock (see Writes and concurrency). Temporary files written during an atomic write are dot-prefixed and so are ignored.

## Pages

A page is a markdown file `<Title>.md`, or an editor file such as `<Title>.excalidraw` (see Editor pages). Its children live in a sibling folder with the same name:

```
Competitors.md
Competitors/
  Acme.md
  Acme/
    Pricing.md
```

- A folder with no matching `.md` beside it is a page with an empty body. Its children are the folder's contents.
- When such a folder contains `README.md` or `index.md` (case-insensitive, `README.md` preferred), that file is the folder page's body, not a child. This is how an imported folder of docs keeps its landing page. When `Name.md` exists beside `Name/`, a `README.md` inside is an ordinary child page.
- Files that are neither pages nor table `.csv` files (images, attachments) are carried along by moves but are not pages.

### Frontmatter

Frontmatter is flat YAML, read with the YAML core schema (dates stay strings):

```yaml
---
id: 01J9Z3K6V4C2W8N5QX7R1T0BHM
title: "R/D: plans?"
type: competitor
order: 3000
status: active
tags: [ai-ide, cli]
---
```

- `id`, `title`, `type` and `order` are reserved. Every other key is a field: a plain page's own fields (`status`, `owner`, `summary`, `tags`), or a typed page's fields as defined by its type.
- `type` makes the page a typed page (a tracker item of that type). Without it the page is a plain page.
- Unknown keys are kept on every write.
- Legacy: a `trackerStatus:` block is read as `type` plus fields, with top-level keys winning. The first field write through the library flattens it into top-level keys. Other `<kind>Status:` blocks (`planStatus`, `decisionStatus`) are not interpreted; they read as ordinary fields.
- A file without frontmatter is a valid page with no id yet (see Ids).

### Ids

- Ids are ULIDs (26 Crockford base32 characters), stored as `id` in frontmatter, and never change when a page moves or is renamed.
- Any id a reader accepts, from frontmatter, a sidecar, a CSV row, a trash manifest or a caller, is a safe token: `A-Z a-z 0-9 _ -`, with at most one `prefix:` namespace (`type-page:competitor`), up to 200 characters. Ids end up in file names (trash entries, with `:` written as `_`), so anything else (`/`, `\`, `..`) is refused. A page whose stored id is not a safe token is reported (`unsafe-id`), read under a `bad_` id, and is read-only until fixed by hand; a writer never rewrites it. A CSV row with such an id is reported and cannot be updated or deleted; a trash entry with one cannot be restored.
- A page file with no `id` is given one the next time a writer scans the wiki. The writer inserts the `id:` line at the top of the existing frontmatter rather than re-serializing it, so comments and formatting survive.
- When two files carry the same id (a copied file, or a sync rename whose add arrived before its delete), the first in walk order keeps it. The walk is depth-first with names sorted by code point, except that a sync conflict copy (`Name (conflict <date>).md`) never keeps the id from the file it diverged from. The other file is reported (`duplicate-id`) and read under a `dup_` id derived from its path; nothing is written to it, so a duplicate that resolves itself (the delete arrives) leaves no trace. It is given a new stored id when a writer writes to it, or once the duplicate has been seen for 60 seconds.
- A bare folder has nowhere to store an id. Readers derive one from its path (`dir_` plus a hash); it is stable until the folder is renamed outside the library. The first write that has to persist something about a bare folder (body, title, order, fields) creates `Name.md` beside it, keeping the derived id.
- A reader that is not allowed to write (repair off) derives `tmp_` ids for files without one. A malformed file gets a `bad_` id.
- A writer re-reads a file before repairing it (adding an id, replacing a duplicate one, repointing links, filling row ids) and skips the repair if the file no longer matches what the scan saw, for example because another writer stored an id in the meantime.

### Titles and file names

The file name follows the title. To turn a title into a file name stem:

1. Normalize to NFC; replace control characters with a space; replace each of `/ \ : * ? " < > |` with `-`.
2. Collapse whitespace, trim, drop leading dots and trailing dots and spaces.
3. Cut to 200 UTF-8 bytes. An empty result becomes `Untitled`. Windows device names (`CON`, `NUL`, `COM1`, ...) get a trailing `_`.

Clash rule: within one folder, two pages clash when their stems are equal after NFC normalization and lowercasing, so the tree works on case-insensitive file systems. A page folder's name counts like its `.md` stem. A new or renamed page whose stem clashes takes the first free ` (2)`, ` (3)`, ... suffix. In a folder whose page has no `Name.md` (a bare folder or a README page), `README` and `index` count as taken, so a child cannot become its parent's body by accident. A case-only rename of a page (`Acme` to `ACME`) is allowed and goes through a temporary name.

When the title cannot be read back from the file name (characters were replaced, or a clash suffix was added), the title is stored as `title` in frontmatter. The page's title is `title` when the file name is still derived from it (exactly, or with a clash suffix); otherwise the file name wins. A file renamed outside Nimbalyst therefore takes its new name as its title.

Readers report (but do not fix) names that differ only by case in one folder, which can only happen on a case-sensitive file system and will collide when the folder is checked out on macOS or Windows.

### Order

`order` is a number, sparse: new pages get the largest sibling order rounded down to a multiple of 1000, plus 1000. Inserting between two siblings uses the midpoint, so neighbors are never renumbered. Siblings without `order` sort after the ordered ones, by title. Table types take part in their folder's order through `tables.<typeId>.order` in the root file.

## Editor pages

A page can also be a file of an editor type: a drawing (`.excalidraw`), mind map (`.mindmap`), data model (`.prisma`), mockup (`.mockup.html`), spreadsheet (`.csv`), calc sheet (`.calc.md`), canvas (`.canvas`), or any other type an installed extension can share. The file keeps its own extension and its content is exactly what that editor reads and writes; the format never adds anything to it.

```
Flow.excalidraw
.Flow.excalidraw.wiki.yaml
Flow/
  Notes.md
```

- **Which files.** A file is an editor page when its name ends in a suffix the reader knows as an editor type (longest suffix wins, so `Budget.calc.md` is a calc sheet, not markdown), or when it has a sidecar. Readers ship with the suffixes above; a host that knows more editor types (the desktop app, from its installed extensions) adds them. Code and plain text files are never pages.
- **Title** is the file name without the suffix (`Flow`), with the same title rules as markdown pages. **Children** live in the sibling folder named after it, as for markdown, and stems clash across both kinds: `Flow.md` and `Flow.excalidraw` cannot sit in one folder.
- **Sidecar.** The page's metadata lives in a hidden YAML file beside it, named `.` + the full file name + `.wiki.yaml`:

  ```yaml
  id: 01J9Z3K6V4C2W8N5QX7R1T0BHM
  title: "Flow: v2"
  documentType: excalidraw
  order: 3000
  owner: kim
  ```

  `id`, `title` and `order` follow the markdown rules. `documentType` records the type the writer knew, so a reader without that editor can still name it; a reader that knows the suffix uses its own type. Every other key is a plain page field. A writer creates the sidecar when it creates the page; a scan with repair on gives a sidecar (with a new id) to an editor file that has none, the same way a markdown file without an id gets one.
- **Plain pages only.** An editor page has no `type`; a `type` key in a sidecar is kept but not read, and setting a type is refused.
- **Body.** An editor page's body is the whole file text. Its version is the content hash of that text, and a body write is checked against it like a markdown body.
- **Moves.** Renames, moves, trash and restore carry the sidecar with its file (and the child folder). A sidecar whose file is gone is reported, not deleted.
- **Table types win.** A `.csv` named after a table type (see Table types) is that table, never a spreadsheet page; any other `.csv` is a spreadsheet page.

## Links

A link between pages is a relative markdown link whose title carries the target id:

```markdown
[Acme](../Competitors/Acme.md "id=01J9Z3K6V4C2W8N5QX7R1T0BHM")
[Ops](../Ops/ "id=dir_...")
[Flow](../Flow.excalidraw "id=01J9Z3M2...")
```

- The path works on GitHub, in editors, and for agents. Spaces, `%`, parentheses, `<`, `>`, `#`, `?` and `"` are percent-encoded in the path; a `#fragment` is kept.
- A link to a bare folder ends in `/`.
- When the library moves or renames a page, it rewrites every link into or out of the moved pages whose path no longer reaches its target, adding the `id=` title as it goes. Links inside a moved subtree that still resolve are left alone.
- On every scan, a link whose `id` exists but whose path points elsewhere (a move made outside the library) is repointed. A link whose id no longer exists is reported, not changed.
- Links without an id are resolved by path only. Images, fenced code blocks and inline code are never touched.

## Type definitions

Types stay in the project's `.nimbalyst/trackers/<type>.yaml`, the same files the app already uses. The format adds one key:

```yaml
type: partner
displayName: Partner
displayNamePlural: Partners
storage: table   # or pages (the default)
fields:
  - name: title
    type: string
  - name: tier
    type: select
```

- `storage: pages`: one markdown page per item, with a body and children.
- `storage: table`: one CSV for the whole type. No bodies, no children.
- **A type is a wiki type only when it declares `storage:`.** Its items live in the wiki. A type without the key (bugs, tasks, any app-database type) keeps its items in the app; the wiki still reads its definition so a page can link to such items, but tools must not create its items as files. Placing a type in the wiki writes `storage: pages` (or `table`) into its YAML. A typed page whose type lacks the key is still read, with `pages` storage.
- The app's other type keys (`icon`, `color`, `modes`, `idPrefix`) are optional on a wiki type. The app fills them in when they are missing, and a type may set them.
- `*.patch.yaml` files and backups are not type definitions. `extends` is resolved one level deep: the parent's fields, then the child's.

## Table types

A table type's items live in one CSV, named after the type's plural display name (`Partners.csv`; `<typeId>.csv` is also recognized), placed in the folder of the page it sits under. Moving the table moves the file. If a wiki has two CSVs for one type, the first in walk order is used and the other is reported.

- RFC 4180: comma-separated, `"` quoting with `""` for a literal quote, quoted fields may hold newlines. Readers accept CRLF or LF and a UTF-8 BOM; writers emit LF and no BOM, and quote a field holding a comma, quote, CR, LF, or leading or trailing whitespace.
- The first row is the header. The first column is `id`. The other columns are field names from the type definition. A writer keeps existing columns in their order, appends fields the type gained, and keeps columns the type does not define.
- An empty cell is an absent field.
- Cell encoding by field type:
  - `multiselect`, `label-ref`, `array` (of scalars), and `relationship` with `multiValue: true`: values joined with `;`; a literal `;` is `\;` and a literal `\` is `\\`. Whitespace around each value is trimmed.
  - `relationship` (single): the target item's id.
  - `number`: a decimal number. `boolean`: `true` or `false`.
  - `object`, `citation`, `array` of objects: JSON.
  - `url`: the URL.
  - everything else: the text as is.
- The item title is the column named by the type's `roles.title` (default `title`).
- A row with an empty or duplicate id is given a new ULID on the next scan by a writer.
- Converting a table type to pages writes one page per row in the CSV's folder, reads each back, then moves the CSV to trash and changes `storage: table` to `storage: pages` in the type file.

## Activity

Typed items keep an append-only activity log in JSON Lines beside them: `Acme.activity.jsonl` next to `Acme.md`, or `Partners.activity.jsonl` next to `Partners.csv` for every row of a table type. It moves, trashes and restores with its item.

```json
{"at":"2026-10-08T21:00:00.000Z","itemId":"01J...","action":"update","actor":"greg","changes":{"status":{"from":"active","to":"defunct"}}}
```

`action` is `create`, `update`, `trash` or `restore`. Readers skip lines that do not parse (a torn last line).

## Trash

Deleting never removes data. A deleted page moves to `.trash/<millis>-<id>/` with its child folder and activity file. A deleted table row is stored in the manifest. Each entry has `.trash.json`, written before anything moves:

```json
{
  "formatVersion": 1,
  "kind": "page",
  "id": "01J...",
  "title": "Acme",
  "trashedAt": 1760000000000,
  "originalParentId": "01J...",
  "originalDir": "Competitors",
  "entries": { "md": "Acme.md", "dir": "Acme", "activity": "Acme.activity.jsonl" },
  "pageType": "competitor"
}
```

For an editor page, `entries` names `file` and `sidecar` instead of `md`, and the manifest adds `documentType` and `fileExtension`. `kind` is `page`, `row` (with `typeId` and `row`, column to cell) or `table` (a converted CSV). Restore puts a page back under its original parent page, else in its original folder if it still exists, else at the root, applying the clash rule; links to it are repaired by the next scan. Only an explicit purge of an entry already in trash deletes files.

## Writes and concurrency

- Every file write is atomic: write a dot-prefixed temp file beside the target, then rename over it. A file that must not replace one another writer may have made (a new table CSV) is created with an exclusive open instead; if it exists, the writer reads and uses it.
- **Write lock.** Every writer (the desktop app, `nim`, any other tool that changes the wiki) holds `.nimbalyst-wiki.lock` in the root for the whole of each change, repairs included, and re-reads the files it is about to change after taking it. To take the lock, create the file with an exclusive open (`O_CREAT|O_EXCL`) and write one JSON line: `{"pid":123,"host":"name","acquiredAt":1760000000000,"token":"<random>"}`. If it exists, wait and retry (the library waits up to 10 seconds, then fails the change). While holding it, touch its mtime every few seconds. Release by deleting it, only if it still holds your token. A lock is abandoned, and may be taken over, when its `host` is this machine and its `pid` is not running, or when its mtime is more than 30 seconds old. Take over by renaming it to a unique dot-prefixed name, checking the renamed file is the one you judged abandoned (same token), deleting it, and creating your own. Reading never takes the lock.
- A page body's version is a hash of the body without frontmatter (an editor page: of the whole file), so a field change does not conflict with a body edit. A body write names the version it was based on; under the lock, the writer re-reads the file and rejects the write if the version moved, and the caller re-reads. Of two writers starting from the same version, one succeeds and the other gets the conflict.
- Moving a page is two renames (the file, then its folder). A crash between them leaves the folder as a bare folder page beside the moved file; nothing is lost, and the user can move the folder back.

## Not part of the format

Backlinks, search indexes, saved views, kanban positions and read state are caches. The app may keep them in its database; `nim` builds what it needs in memory. Comments on local items are not supported in version 1.
