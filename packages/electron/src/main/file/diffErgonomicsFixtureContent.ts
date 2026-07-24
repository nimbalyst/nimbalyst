/**
 * Fixture markdown for the diff ergonomics test harness.
 *
 * Each `## ` section is one scenario so it shows up in the document outline.
 * Pattern per section: heading, italic "what this tests" line, then content.
 * `HARNESS_BEFORE` is what we write first and tag as the baseline; we then
 * overwrite the file with `HARNESS_AFTER` so the editor renders the change
 * as a pending AI diff.
 */

export const HARNESS_BEFORE = `# Diff Ergonomics Test Harness

This document exercises the WYSIWYG diff system across many edit shapes. The file was written to disk with this "before" content, then immediately overwritten with the "after" content and tagged as a pending AI edit. Use the diff header at the top of the editor to step through each change group and judge whether the grouping feels right.

The headings below appear in the document outline — use them to jump to a scenario.

## Single-word inline change

_Small in-line change inside a paragraph. Expect a tight inline red/green span around just the changed word, not the whole paragraph._

The quick brown fox jumps over the lazy dog while the slow turtle naps in the warm afternoon sun.

## Multiple inline changes in one paragraph

_Two unrelated word swaps in the same paragraph. Should they be one change group or two? The harness lets you judge._

Alice met Bob at the cafe on Tuesday morning to review the quarterly numbers and discuss the upcoming product launch.

## Whole-line replacement

_The entire line is replaced with unrelated content. Expect one full-line removal followed by one full-line addition, not a confusing word-level diff._

Roses are red, violets are blue, sugar is sweet, and so are you.

## Punctuation-only change

_Tiny edits like adding a comma. The change should be visible without making the surrounding text look modified._

She walked into the room sat down and started reading the report immediately.

## Bold and italic toggling

_Inline formatting added and removed. The text content does not change in some places — only the formatting does._

This sentence has no emphasis at all. This sentence already has **some bold words**. This sentence has *italics in the middle* of it.

## Link edits

_URL change, link text change, and a plain phrase being turned into a link._

Visit [Anthropic's homepage](https://example.com/old) for more information. Read the [Claude documentation](https://docs.anthropic.com) to get started. The Lexical project is great.

## Sub-bullet with link -- URL changed

_A nested bullet that mixes plain text ("URL: ") with a link, where only the link's URL changes. The "URL: " prefix and unchanged sibling sub-bullets must stay plain; only the changed link should flash, ideally as a paired remove/add side-by-side -- not as a whole-bullet block fallback._

- Test Links
  - URL: [https://example.com/test-link](https://example.com/test-link)
  - URL: [https://example.com/test-link2](https://example.com/test-link2)

## Inline code and code block

_Inline backtick swap, plus a multi-line code block where one line in the middle changes._

Use \`getElementById\` to find the node, then read \`textContent\`.

\`\`\`typescript
function greet(name: string): string {
  const greeting = "Hello";
  return greeting + ", " + name + "!";
}
\`\`\`

## Bullet list — single item edit

_One bullet's text changes; the others are unchanged. Sibling bullets must not appear modified._

- Apples are red and grow on trees.
- Bananas are yellow and grow in tropical climates.
- Cherries are small and have pits.
- Grapes grow in clusters on vines.

## Bullet list — add and remove items

_New bullets inserted, an existing bullet removed. Expect added/removed markers at the list-item level._

- Buy milk
- Buy eggs
- Buy bread
- Buy coffee

## Bullet list — promote to sub-bullet

_An item moves from top level to nested under the previous item. Tests whether structural moves are shown coherently._

- Frontend
- React components
- State management
- Backend
- API endpoints

## Numbered list reorder and edit

_Items reordered and one item's text edited. Tests whether reorders are recognized or shown as remove+add._

1. Wake up
2. Brush teeth
3. Eat breakfast
4. Go to work

## Checklist state changes

_Some items get checked, some get unchecked, and one item's text changes._

- [ ] Write the proposal
- [ ] Send it to the team
- [x] Schedule the kickoff meeting
- [ ] File the initial expense report

## Blockquote edits

_Text inside a blockquote is modified. The quote markers should not look like they were re-added._

> The only way to do great work is to love what you do.
>
> If you have not found it yet, keep looking. Do not settle.

## Heading text changes

_An h2 and an h3 get their text rewritten. The headings should remain navigable in the TOC after the edit._

### Old subsection title

Some content under the old subsection that stays the same across the diff.

### Another subsection

More content that does not change.

## Table — single cell edit

_One cell's text changes. Surrounding cells, the row, and the table itself should not look modified._

| Name    | Role        | Location  |
| ------- | ----------- | --------- |
| Alice   | Engineer    | New York  |
| Bob     | Designer    | London    |
| Carol   | Manager     | Berlin    |

## Table — row added and removed

_A new row is added, an existing row is removed. Expect row-level add/remove markers._

| Product   | Price | Stock |
| --------- | ----- | ----- |
| Widget    | $10   | 100   |
| Gadget    | $25   | 50    |
| Sprocket  | $5    | 200   |

## Table — column added

_A whole column is added on the right. Tests whether column adds are coherent or fragmented per row._

| City      | Country |
| --------- | ------- |
| Paris     | France  |
| Tokyo     | Japan   |
| Cairo     | Egypt   |

## Table — column removed

_The middle column is removed. Tests whether column removes are coherent across all rows._

| First | Middle | Last  |
| ----- | ------ | ----- |
| Ada   | "Cool" | Lovelace |
| Alan  | "M"    | Turing  |
| Grace | "B"    | Hopper  |

## Horizontal rule and paragraph reorder

_Two paragraphs surrounding a horizontal rule swap places._

The first paragraph talks about the morning routine and how the day starts off slow but picks up steam by noon.

---

The second paragraph describes the evening, when work winds down and the sun sets behind the hills.

## Image alt text and source change

_The image alt text is rewritten and the src URL is updated. The image element itself stays in place._

![old caption](https://example.com/old-image.png)

## Multi-line paragraph rewrite

_A whole paragraph is rewritten while keeping the same general topic. Tests whether the diff system stays line-aligned or fragments into many small inline edits._

The migration script reads the old database, transforms each row using a configurable pipeline, and writes the result to the new database. It logs progress to stdout every 1000 rows. If a row fails to transform, the script aborts and prints the error.

## Near-complete paragraph rewrite

_Marketing copy rewritten almost end-to-end. Old and new share only a few short tokens ("the", " is ", "you", " on ") so a word-level diff produces tightly interleaved red/green fragments that are unreadable. Expect the whole old paragraph to appear as one removed block followed by the new paragraph as one added block, not interleaved word-by-word._

We're hosting it with Jellyfish dev tools VC starting tonight before BosTech Tech Week, and the premise is simple. Stop buying them, not waiting for vendors to ship a vendor roadmap. Build it yourself, build on them. That shift has a name: malleable software, with agents doing the heavy lifting.

## Middle sentence rewritten in a multi-sentence paragraph

_Three sentences in one paragraph. The first and last sentences are identical before and after; only the middle sentence is heavily rewritten. The ideal rendering shows the first and last sentences cleanly unchanged, with the middle sentence appearing as one removed block followed by one added block at the sentence boundary -- not as word-level interleaving across the middle, and not as a whole-paragraph replacement that drags the unchanged sentences with it._

The team meets every Monday at 9am to review last week's work. Bob spent the past three days untangling the legacy authentication module so it would finally pass the new compliance audit our security team has been demanding. The next sprint kicks off on Wednesday with a fresh set of priorities.

## Trailing content unchanged

_The very last section is identical before and after. Use this as a control to confirm unchanged content does not show diff styling._

This paragraph at the bottom of the document is intentionally identical in the before and after states. If you see any red or green styling on this section, the diff system has a false positive.
`;

export const HARNESS_AFTER = `# Diff Ergonomics Test Harness

This document exercises the WYSIWYG diff system across many edit shapes. The file was written to disk with this "before" content, then immediately overwritten with the "after" content and tagged as a pending AI edit. Use the diff header at the top of the editor to step through each change group and judge whether the grouping feels right.

The headings below appear in the document outline — use them to jump to a scenario.

## Single-word inline change

_Small in-line change inside a paragraph. Expect a tight inline red/green span around just the changed word, not the whole paragraph._

The quick red fox jumps over the lazy dog while the slow turtle naps in the warm afternoon sun.

## Multiple inline changes in one paragraph

_Two unrelated word swaps in the same paragraph. Should they be one change group or two? The harness lets you judge._

Alice met Bob at the diner on Friday morning to review the quarterly numbers and discuss the upcoming product launch.

## Whole-line replacement

_The entire line is replaced with unrelated content. Expect one full-line removal followed by one full-line addition, not a confusing word-level diff._

The rain in Spain falls mainly on the plain during late autumn evenings.

## Punctuation-only change

_Tiny edits like adding a comma. The change should be visible without making the surrounding text look modified._

She walked into the room, sat down, and started reading the report immediately.

## Bold and italic toggling

_Inline formatting added and removed. The text content does not change in some places — only the formatting does._

This sentence has *no emphasis at all*. This sentence already has some bold words. This sentence has **italics in the middle** of it.

## Link edits

_URL change, link text change, and a plain phrase being turned into a link._

Visit [Anthropic's homepage](https://anthropic.com) for more information. Read the [official Claude docs](https://docs.anthropic.com) to get started. The [Lexical project](https://lexical.dev) is great.

## Sub-bullet with link -- URL changed

_A nested bullet that mixes plain text ("URL: ") with a link, where only the link's URL changes. The "URL: " prefix and unchanged sibling sub-bullets must stay plain; only the changed link should flash, ideally as a paired remove/add side-by-side -- not as a whole-bullet block fallback._

- Test Links
  - URL: [https://example.com/test-link](https://example.com/test-link)
  - URL: [https://example.com/test-link3](https://example.com/test-link3)

## Inline code and code block

_Inline backtick swap, plus a multi-line code block where one line in the middle changes._

Use \`querySelector\` to find the node, then read \`innerText\`.

\`\`\`typescript
function greet(name: string): string {
  const greeting = "Howdy";
  return greeting + ", " + name + "!";
}
\`\`\`

## Bullet list — single item edit

_One bullet's text changes; the others are unchanged. Sibling bullets must not appear modified._

- Apples are red and grow on trees.
- Bananas are yellow and rich in potassium.
- Cherries are small and have pits.
- Grapes grow in clusters on vines.

## Bullet list — add and remove items

_New bullets inserted, an existing bullet removed. Expect added/removed markers at the list-item level._

- Buy milk
- Buy oat milk
- Buy bread
- Buy coffee
- Buy filters

## Bullet list — promote to sub-bullet

_An item moves from top level to nested under the previous item. Tests whether structural moves are shown coherently._

- Frontend
  - React components
  - State management
- Backend
  - API endpoints

## Numbered list reorder and edit

_Items reordered and one item's text edited. Tests whether reorders are recognized or shown as remove+add._

1. Wake up
2. Eat a healthy breakfast
3. Brush teeth
4. Go to work

## Checklist state changes

_Some items get checked, some get unchecked, and one item's text changes._

- [x] Write the proposal
- [x] Send it to the team
- [ ] Schedule the kickoff meeting
- [ ] File the final expense report

## Blockquote edits

_Text inside a blockquote is modified. The quote markers should not look like they were re-added._

> The only way to do truly great work is to love what you do.
>
> If you have not found it yet, keep looking. Do not give up.

## Heading text changes

_An h2 and an h3 get their text rewritten. The headings should remain navigable in the TOC after the edit._

### Renamed subsection title

Some content under the old subsection that stays the same across the diff.

### Another subsection

More content that does not change.

## Table — single cell edit

_One cell's text changes. Surrounding cells, the row, and the table itself should not look modified._

| Name    | Role        | Location  |
| ------- | ----------- | --------- |
| Alice   | Engineer    | New York  |
| Bob     | Art Director | London   |
| Carol   | Manager     | Berlin    |

## Table — row added and removed

_A new row is added, an existing row is removed. Expect row-level add/remove markers._

| Product   | Price | Stock |
| --------- | ----- | ----- |
| Widget    | $10   | 100   |
| Sprocket  | $5    | 200   |
| Gizmo     | $40   | 12    |

## Table — column added

_A whole column is added on the right. Tests whether column adds are coherent or fragmented per row._

| City      | Country | Population |
| --------- | ------- | ---------- |
| Paris     | France  | 2.1M       |
| Tokyo     | Japan   | 13.9M      |
| Cairo     | Egypt   | 9.5M       |

## Table — column removed

_The middle column is removed. Tests whether column removes are coherent across all rows._

| First | Last     |
| ----- | -------- |
| Ada   | Lovelace |
| Alan  | Turing   |
| Grace | Hopper   |

## Horizontal rule and paragraph reorder

_Two paragraphs surrounding a horizontal rule swap places._

The second paragraph describes the evening, when work winds down and the sun sets behind the hills.

---

The first paragraph talks about the morning routine and how the day starts off slow but picks up steam by noon.

## Image alt text and source change

_The image alt text is rewritten and the src URL is updated. The image element itself stays in place._

![updated caption describing the new image](https://example.com/new-image.png)

## Multi-line paragraph rewrite

_A whole paragraph is rewritten while keeping the same general topic. Tests whether the diff system stays line-aligned or fragments into many small inline edits._

The migration script streams rows from the source database, applies a user-supplied transform to each one, and bulk-writes batches of 500 rows into the destination. Progress is logged every 10 seconds. On failure, the script records the offending row, skips it, and continues — never aborting the run.

## Near-complete paragraph rewrite

_Marketing copy rewritten almost end-to-end. Old and new share only a few short tokens ("the", " is ", "you", " on ") so a word-level diff produces tightly interleaved red/green fragments that are unreadable. Expect the whole old paragraph to appear as one removed block followed by the new paragraph as one added block, not interleaved word-by-word._

Malleable software: The teams using Pillar are starting the build before Tech Week. Stop waiting for vendors to ship the workflow you need. Build it yourself, on top of an open visual workspace, with agents doing the heavy lifting.

## Middle sentence rewritten in a multi-sentence paragraph

_Three sentences in one paragraph. The first and last sentences are identical before and after; only the middle sentence is heavily rewritten. The ideal rendering shows the first and last sentences cleanly unchanged, with the middle sentence appearing as one removed block followed by one added block at the sentence boundary -- not as word-level interleaving across the middle, and not as a whole-paragraph replacement that drags the unchanged sentences with it._

The team meets every Monday at 9am to review last week's work. Carol drafted a one-page redesign of the onboarding flow after watching a half-dozen new users get stuck on the second screen during yesterday's user testing. The next sprint kicks off on Wednesday with a fresh set of priorities.

## Trailing content unchanged

_The very last section is identical before and after. Use this as a control to confirm unchanged content does not show diff styling._

This paragraph at the bottom of the document is intentionally identical in the before and after states. If you see any red or green styling on this section, the diff system has a false positive.
`;
