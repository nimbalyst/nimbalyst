---
description: Record what people decided in this session in the wiki pages it affects (team or local wiki)
argument-hint: "[optional focus]"
---

Record what this session decided in the project's wiki. Load the `update` skill and follow it for every write; the `connect` skill covers choosing the wiki and finding the project.

Focus, if given: $ARGUMENTS

1. If the desktop app's wiki tools are available (`mcp__nimbalyst-trackers__*`), use them and the desktop wiki skills instead of this plugin's tools.
2. Choose the wiki as the `connect` skill describes. For the team wiki, call `pages_status` with `repo` and `project`; if the state is `ambiguous`, ask which project and pin it; if it is `unbound`, follow the skill's connecting steps. For a local wiki, use the `nimbalyst-local` tools; if there is none yet, offer to start one. If there is still no wiki to write to, say so and stop.
3. Read the guide page ("How we write this wiki": `guideLink` on the team wiki, `listPages` on a local one) and follow it.
4. List the candidates from this session: decisions people made (who, what was not chosen, and why), questions answered or left open, and context a teammate would need to see the whole problem. Drop routine progress and anything the code or `git log` already says.
5. If nothing is left, reply "nothing to record" and stop.
6. Otherwise, find the page each candidate affects with `listPages` and `readCollabDoc`, and write it there as the skill says: a decided or open mark on the sentence, a citation from `list_session_inputs` when the person's own words support it. Extend existing pages; create a page only when none fits. When the project came from a pin or the user is in several teams, first say which project the writes go to; on a local wiki, say which folder.
7. End your reply with the pages you updated, one link per line.
