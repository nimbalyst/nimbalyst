# Design review: `RichCommentBody`

Reviewer: the shared comment renderer/composer workstream. Subject: `RichCommentBody` in `packages/collab-protocol/src/comments.ts:40`.

This is a report, not a patch. The protocol package is owned by another workstream and this change needs coordination across the renderer, the composer, server-side validation, and per-room FTS.

## The contract under review

```ts
export type RichCommentBody = {
  format: "plainText" | "markdown";
  text: string;
};
```

Validated by `validateRichCommentBody`, which bounds `JSON.stringify(body)` at 32 KiB.

The plan referenced `RichCommentBody` in the `Comment` shape but never defined it. An earlier session invented the two-field form above so the contract would compile. That inference is reasonable and the bounded-body intent is right. It is also, as it stands, **not adequate** for the surfaces that now depend on it.

## Verdict

**Not adequate as-is.** It is adequate as a *storage* shape and inadequate as a *presentation* shape, and the plan asks it to be both — every surface renders through one shared component, and the server derives mention recipients and FTS rows from the same field.

Three defects, in descending order of consequence.

### 1. No inline structure, so mentions and pills have to be smuggled through prose

`resourceRefs` and `deliveryHints` live beside the body, not inside it, so nothing in the contract says *where* in the sentence a mention or a pill appears. A body reading "ship it" with `mentionedUserIds: ["user-dana"]` is well-formed and unrenderable.

To render at all, this workstream had to invent a renderer-local token grammar inside `text` (`commentBodyParser.ts`):

```
[Label](nimbalyst://user/<userId>)     person mention
[Label](nimbalyst://session/<id>)      agent mention
[Label](nimbalyst://tracker/<id>)      resource pill (and the other six kinds)
nimbalyst://...                        bare form, as produced by paste
:shortcode:                            emoji
```

with the safety rule that a token becomes a pill or a mention **only if corroborated** by `resourceRefs` / `deliveryHints`. That inversion is sound and is tested (`CommentRow.test.tsx`, "does not turn an uncorroborated mention token into a mention"). But it is a convention held in one renderer, not in the protocol:

- The **server** must parse the identical grammar to recompute mention recipients. It has no contractual basis to. Any drift between the two parsers is a silent misrouted notification — the class of bug [NIM-2212](nimbalyst://NIM-2212) already demonstrates is expensive here.
- **iOS** and any future surface must reimplement the same regex from a code comment.
- The two halves **can disagree**. `deliveryHints` naming a user with no token in the body notifies someone whose name is nowhere in the message. A token with no hint renders as literal `[@Dana Okafor](nimbalyst://user/user-dana)` — which is what the renderer does today, correctly and ugly.

### 2. `format: "markdown"` names no subset, so every surface renders differently

The contract admits "markdown" and says nothing about which markdown. This renderer implements inline `**strong**`, `*emphasis*`, and `` `code` `` and deliberately ignores block constructs, so a body containing a fenced code block or a list renders as literal characters. That is a defensible V1 choice, but it is *this renderer's* choice: a future mobile surface using a real markdown library would render the same stored bytes differently, and neither is wrong under the contract.

Two concrete hazards:

- A markdown link is `[label](url)`. This is exactly the token grammar in defect 1. A body with an ordinary `[docs](https://example.com)` link, and a body with a pill token, are the same syntax with different meaning — the renderer distinguishes them only by the `nimbalyst://` scheme. That is a coincidence, not a contract.
- Block markdown is an injection surface for the server-side FTS indexer, which will index whatever it is handed.

### 3. Byte bound is measured on a shape that is not the wire shape

`validateRichCommentBody` measures `JSON.stringify(body)`, so the 32 KiB budget silently includes `{"format":"markdown","text":""}` — 33 bytes of envelope — and JSON escaping. The composer has to replicate that exact calculation to agree with the server (`validateDraft` does; the test pins it at the byte). If the body type ever gains a field, every previously-acceptable message near the limit becomes rejectable without any version change. Bound the *content*, not its serialization.

## Recommendation

Keep the shape, make the structure explicit. Concretely, promote the token grammar out of the renderer and into the protocol as a validated, non-optional part of the contract:

```ts
export type RichCommentBody = {
  /** Bump when the grammar changes; readers refuse unknown majors. */
  version: 1;
  format: "plainText" | "nimbalystMarkdown";
  text: string;
  /**
   * Byte offsets into `text` naming the mentions and references it contains.
   * Server-recomputed; the client's copy is a hint like deliveryHints.
   */
  entities?: BodyEntity[];
};

export type BodyEntity =
  | { start: number; end: number; kind: "userMention"; userId: string }
  | { start: number; end: number; kind: "agentMention"; sessionId: string }
  | { start: number; end: number; kind: "resource"; refIndex: number };
```

Why this shape rather than a rich AST or a Y.Doc fragment:

- **Offsets keep the body one flat string.** FTS still indexes `text` directly, the 32 KiB bound still means something a human can reason about, and `plainText` bodies stay trivially cheap. A nested AST would make all three worse.
- **`refIndex` into `resourceRefs` removes the two-halves problem.** An entity that points at no ref is a validation error, not a rendering judgment call. Same for a `userMention` whose `userId` is not in `deliveryHints.mentionedUserIds`. Both become server-checkable in a single pass, which is exactly what the plan asks the server to do ("the server recomputes them before delivery fanout").
- **`entities` is optional and additive.** A body with no entities is what exists today, so V1 rooms keep working and this is not a migration.
- **Naming the dialect `nimbalystMarkdown` and versioning it** makes the inline subset a contract instead of a convention, and gives a future renderer something to refuse rather than misrender.

Two smaller changes, independent of the above and cheap:

- Bound `text` by its own UTF-8 byte length rather than `JSON.stringify(body)`, and keep a separate, generous envelope bound. Then adding a field cannot retroactively invalidate stored messages.
- Document that `format: "plainText"` means *no* inline interpretation at all — including no emoji shortcode substitution — so plain-text bodies from imported sources are never reinterpreted.

## If the recommendation is declined

The token grammar has to move somewhere shared regardless. The minimum acceptable outcome is a parser exported from `@nimbalyst/collab-protocol` that the renderer, the composer, the server's mention recomputation, and the FTS indexer all import, with contract tests asserting the four agree on the same corpus. Leaving four independent implementations of an undocumented regex is the shape of the next misrouted-notification incident.

## What this workstream did in the meantime

- Implemented the grammar in `commentBodyParser.ts`, documented at the top of that file, with the corroboration rule as its stated safety property.
- Enforced the existing bounds exactly as `validateRichCommentBody` computes them, so the composer and the server agree today (`commentViewModel.validateDraft`, pinned by tests at the limit and one byte over).
- Did not modify `packages/collab-protocol`.
