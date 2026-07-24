# Markdown Compatibility Philosophy

Nimbalyst is a markdown‑native editor designed for editing valid Markdown. While we do support extended and custom Markdown syntax, we intentionally exclude features that cannot be easily or reliably expressed in some Markdown syntax.

Our goal is to make Markdown the single source of truth: what you see and edit in the UI must map cleanly to a concrete Markdown representation, and round‑trip back without surprises.

## Guiding Principles

- Plain‑text first: The canonical form is Markdown text (plus optional, well‑defined assets such as images).
- Round‑trip safety: Editing in the UI and switching to Markdown view should preserve meaning and structure.
- Predictable interop: Prefer broadly adopted conventions so documents open correctly in other Markdown tools.
- Degrade gracefully: When an extension is not supported elsewhere, it should fall back to a readable Markdown form (e.g., fenced code blocks).
- No invisible state: Avoid features that require proprietary, non‑text metadata to render correctly.

## What We Target

- Common Markdown constructs: headings, paragraphs, emphasis, inline code, code blocks, links, images, blockquotes, horizontal rules, lists, etc.
- Widely used conventions: tables and task lists (GFM‑style), autolinks, strikethrough, and similar de‑facto standards where feasible.
- No HTML passthrough: Only content that can be parsed into Lexical nodes (and thus serialized as Markdown) is editable. Raw HTML that cannot be parsed will not be editable and may appear as plain text.

We strive to maintain compatibility with the CommonMark ecosystem while embracing practical, de‑facto extensions where they map cleanly to Markdown.

## Extensions and Custom Syntax

We support extensions when they:

1. Have a clear, text‑based Markdown representation (for example, fenced code blocks with language tags for diagrams or drawings), and
2. Round‑trip through our editor without loss of information, or degrade to a readable fallback when exported.

Examples of extension patterns we embrace:

- Fenced code blocks for domain‑specific content (e.g., diagram languages or drawings), possibly paired with companion assets.
- Frontmatter blocks for document‑level metadata when appropriate.
- Link/reference conventions that remain valid Markdown even outside Nimbalyst.

## Exclusions and Non‑Goals

We intentionally exclude or limit features that don’t have a clean Markdown mapping, such as:

- Absolute positioning/layout (e.g., arbitrary drag‑and‑drop placement, multi‑column page layouts).
- Rich styling that relies on inline CSS or non‑portable attributes.
- Interactive widgets whose state can’t be serialized to Markdown text.
- Complex table semantics that exceed Markdown capabilities (e.g., nested tables with arbitrary merging that can’t be represented idiomatically).
- Proprietary binary embeddings without a text fallback.

If a feature cannot be expressed as Markdown (or does not degrade gracefully to valid Markdown), it will not be part of the core editor experience.

## Interoperability Notes

- Normalization: The editor may normalize whitespace, list markers, or table alignment for consistency while preserving meaning.
- No HTML passthrough: Raw HTML that cannot be parsed into Lexical nodes will not be editable as rich content and may appear as plain text. We prioritize Markdown representations wherever possible.
- Assets: Linked assets (images, attachments) should use standard Markdown links with stable relative paths when feasible.

## For Extension Authors

When proposing or implementing an extension, please ensure:

- There is a clear Markdown serialization that preserves meaning.
- Documents remain readable in plain‑text form and in other Markdown viewers.
- The feature round‑trips through edit → markdown → edit without loss, or provides a sensible fallback.
- Any additional files (assets) are referenced via standard Markdown constructs.

***

This policy helps us keep Nimbalyst fast, portable, and friendly to the broader Markdown ecosystem while still enabling powerful workflows through well‑behaved extensions.
