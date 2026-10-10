# Migrating older wiki content into pages

The earlier knowledge graph stored knowledge as many small tracker items: `entity` pages with labels, `claim` statements (subject, predicate, object, basis, citations), `question`, `finding` and `investigation` items, `decision` items, and sometimes project types such as `keystone`. It also kept `.nimbalyst/labels.yaml`, label-carrying predicate packs and `ontology-proposal` items. Pages replace all of that with prose in the page a thing is about.

## Rules

- **Never delete, archive or overwrite an old item, type, or registry entry** until a person approves, item by item or batch by batch. Migration only adds pages and page text. Leave the old types, `labels.yaml` and `ontology-proposal` items in place.
- **Keep every source.** Each citation, URL, session id, document link and date on an old item goes into the sentence it supports.
- **Keep who and when.** A decision keeps its decider and date in the mark (`by=`, `email=`, `on=`). Take the email from the team member list (`findOrgMembers`) when the decider is a teammate; leave it out rather than guess. If the old item does not say who decided, write `by="not recorded"`.
<!-- desktop-only -->
- **Never make up a human citation.** Those links (`https://console.nimbalyst.com/app/cite/...`) only come from `list_citable_inputs` for the current session. An old item's URLs and documents become source citations, ordinary links titled `cite` (`[Vendor pricing](https://example.com/pricing "cite")`); its session ids stay as prose ("discussed in session <id>").
<!-- /desktop-only -->
<!-- remote-only -->
- **Never make up a human citation.** Those links only come from `list_session_inputs` and `list_citable_inputs`. An old item's URLs and documents become source citations, ordinary links titled `cite` (`[Vendor pricing](https://example.com/pricing "cite")`); its session ids stay as prose ("discussed in session <id>").
<!-- /remote-only -->
- **Write https links.** Links to pages, typed pages and types are the console links `listPages` returns, not `nimbalyst://`.
- **Show a plan first.** Before writing, list for the person the pages you will create or extend, the types you will use, and where each old item will end up. Then migrate one area at a time and report what you wrote.
- **Note where it came from.** End each migrated passage with the old item's key, for example `(from CLM-41)`, so a person can check it and the old item can be retired later.

## Mapping

| Old | Becomes |
| --- | --- |
| `entity` with a label that names a kind of thing (product, technology, person, organization, subsystem) | A typed page of the project's matching type (Competitor, Technology, Person, Module). Create the type first with the setup skill (`/wiki:setup`) if the team wants it. |
| `entity` that is an area, topic, home or one-off page | A plain page. An area becomes a page with an empty body or a short overview; its children nest under it. |
| `entity.parent` | Tree position: the page sits under its parent page. |
| Label-carrying field properties (status, website, lifecycle) | A single-valued field on the type when the team wants it in the header or the table; otherwise a sentence in the body. Multi-valued properties become body text or a table, never header lists. |
| `claim` between two entities (`subject predicate object`) | A sentence on the subject's page with a link to the object. Add `rel=` only when the project has a relation that fits both types; otherwise a plain link. Drop qualifiers; keep what matters as words in the sentence. |
| `claim` with a text or quantity value (pricing, revenue, headcount) | A sentence or table row on the subject's page, with its date and source. |
| `claim.basis` | Words: "according to their docs", "we tested", "we decided", "we think". |
| Superseded claims | Only the current value, plus "until 2026-08, it was X" when the change matters. |
| `question` with a position | An open mark on the page it affects, `[Do we need X?]{open by="<owner>" email=<owner email>}` (no email when a page or spike owns it), with the current position in the next sentence. If it was decided (`decidedBy`, `decidedAt`), a decided mark instead. |
| `finding` | The answer written as a decision or a conclusion on the page the question affects, with the claims it rested on as linked sources. Keep `scope` and `limitations` as one sentence each. |
| `investigation` | One or two sentences on the affected page: what was tried, when, and what it showed, including inconclusive results, with links to the session or document. |
| `decision` or `keystone` item | `[What was decided.]{decided by="<who>" email=<their email> on=<YYYY-MM-DD> over="<what was not chosen>"}` in the page it affects, with the reason in the next sentence. A decision that affects several pages is marked once on the most specific page and linked from the others. |
| `predicates.yaml` entries | Keep the ones that read as named relations between the project's types, and add `objectKinds` with the setup skill. Do not remove the others. |
| `ontology-proposal` items | Leave them. They describe the old model. |

## Done means

Each migrated page reads well on its own, every old item is either reflected in a page (with its key noted) or listed for the person as deliberately left out, and nothing old was removed. Ask the person whether to retire the old items, and how (archive is safer than delete).
