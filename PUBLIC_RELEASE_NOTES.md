## Nimbalyst v0.83.0

Covers everything since v0.82.8.

### New Features

- Claude Fable 5.2 is available in the model picker. Fable 5.1 and Fable 5 remain selectable as previous-generation options.

### Improvements

- Messages queued while an agent is working, whether typed by you or sent by other sessions, are delivered together in one turn, each labeled with its author. Slash commands and messages with a different document context still go as their own turn.
- On macOS and Linux, agent sessions, MCP servers, CLIs and git now put your login shell's PATH ahead of the system defaults, so tools from version managers such as mise are found before the `/usr/bin` versions.
- A file tree subfolder cut off at the 200-entry limit ends with a row saying how many items are hidden.
- The session machine picker labels the local machine with its device name, followed by "(this device)", instead of "This Mac" on every platform.

### Fixed

- The weekly history in the Claude and Codex usage popovers charts the main weekly limit by default instead of a per-model limit.
- Nested lists under numbered items stay nested after saving in other Markdown tools, and a nested numbered list under item 10 starts at 1.
- A question card that a hook denies now shows as blocked with the hook's reason, instead of as answered or still submittable.
- Orchestrating agents can call `consume_session_inbox` on the `nimbalyst-host` MCP server.
- Switching workspace clears the Agent Sessions search, and a search still running for the previous workspace no longer replaces the new workspace's list.
- A prompt queued after you clear the document no longer merges into a turn with the older document content.
- Creating a local wiki page whose content starts with its own frontmatter writes one frontmatter block instead of two.
- In workspaces with more than 5,000 uncommitted files, the session list skips matching sessions to those files instead of sending every path to the database in one query.
