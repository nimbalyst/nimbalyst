# Decisions and current work

<!-- Example record. `knos export` writes this file in an adopting repo; it is
     plain markdown, so a fresh clone reads it with nothing installed. -->

## Decisions

- **Never assert CSS through jsdom by injecting the CSS you are about to assert on** — that is circular. Assert the `className`, or cover it in E2E where real styles load. _(source: CLAUDE.md)_
- **Add `// @vitest-environment node` as the first line of any test that never touches the DOM.** The jsdom environment costs ~270ms per file for nothing. _(source: CLAUDE.md)_

## Being worked on right now

_Nothing claimed._

---
<sub>One record every agent working in this repo reads. Claims lapse after 30
minutes or on `knos done`.</sub>
