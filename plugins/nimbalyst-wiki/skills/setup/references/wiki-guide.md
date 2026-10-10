These pages hold what the people on this project said and decided, and the context they needed to decide it. Agents can look up everything else. People and agents read this page before writing here.

Edit this page to fit your team. It overrides the base guide Nimbalyst ships.

## What belongs here

- **Decisions and their reasons.** What was chosen, who chose it, when, and what was not chosen. The reason is what stops a later agent from undoing the decision.
- **What people asked for.** Preferences, constraints, taste, and the quality bar, in the words of the person who set them.
- **Open questions.** What is not decided yet, who owns it, and where it stands.
- **Context for the whole problem.** The modules, technologies, competitors, customers and people the team weighs when it decides, with the facts it relies on, each with a source and a date. A competitor table or a list of the libraries a module is built on belongs here when it helps a person see the problem at once.
- **Hard-won lessons.** A failure someone would repeat, with the rule it taught. Skip the incident narrative.

## What does not belong here

- Anything a capable model already knows, or the code already says: APIs, schemas, file layouts, configuration values. Link to the code when a pointer helps.
- Task lists, status updates, plans for single features and meeting notes. Those live in trackers and expire when the work ships.
- Copies. If something is on one page, link to it.

## How the pages fit together

- **Pages nest.** Any page can hold child pages. A page with an empty body works as a folder.
- **Some pages have a type.** A type is something the team keeps several of, such as Modules, Technologies, Competitors or People. A typed page has a few fields in its header (a status, a maturity, "in our stack") and its body is ordinary prose. Each type has its own page: a short description of the type above a table of every page of that type.
- **Types are ours.** Add a type when the team keeps track of several things of one kind and wants them in a table. Do not add a type for a single page.
- **Relations are links.** When a page links to another typed page, the link can carry a named relation, such as "built on" or "alternative to". Each relation has a name for the other direction ("underlies"), and both pages list it in their Links section. Use a plain link when no relation fits; do not invent a vague one like "related to".

## How to write

- Short and specific. A page is usually a few paragraphs. Name the thing, the date and the person.
- Write a decision as one sentence in the page it affects, and mark it decided with who decided it, when, and what was not chosen ("Mark decided" on the selection, or in markdown `[We store flags in Cloudflare Flagship.]{decided by="Dana Lee" email=dana@example.com on=2026-09-30 over="our own Durable Object store"}`). The email lets anyone find every decision a person made.
- Also add a decision record (a tracker item) when no single page owns the decision, work or code hangs off it, it is not settled yet, or the reasons don't fit in the mark. A record never replaces the mark: keep the mark and put the record's key right after it as a link.
- Mark an open question the same way, with who owns it: `[Do we need a mobile SDK for launch?]{open by="Dana Lee" email=dana@example.com}`. A page or a spike can own one too (`{open by="Spike 6"}`). When it is answered, mark it decided.
- When a statement came from a person, cite them: the citation keeps their words and links to the session or comment they came from.
- Cite web pages and documents as you write; they are listed under Sources at the bottom of the page.
- Facts that change (pricing, maturity, limits) carry a date and a source link.
- Mark what is decided, what was observed and what is a guess. Never present a guess as a decision.
- Update a page rather than appending a second page about the same thing. When a decision changes, rewrite the sentence and say what it replaced and when.

## For agents

- Read this page and the Home page before writing.
- Search for an existing page before creating one. Extend it, or link to it.
- Record a decision only when a person made it, in their words, attributed to them. Never invent a decision or a reason.
- Your edits land directly, without review. Keep each edit small, never delete or rewrite what a person wrote without asking, and tell the person which pages you changed.
- When you are unsure whether something belongs here, leave it out and ask.

Based on the Nimbalyst base guide, version 5.
