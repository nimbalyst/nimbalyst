---
name: social-response
description: Draft a response to a user reaching out on Discord or another social channel
---
# /social-response Command

Draft a response to a user reaching out on Discord or another social channel.

## User's Message

$ARGUMENTS

## What This Command Does

The user pastes a message from Discord, Twitter, Reddit, GitHub Discussions, email, or another social channel. Your job is to:

1. Figure out what they're asking for or complaining about
2. Determine whether Nimbalyst already supports it
3. If yes -- draft a friendly, copy-paste-ready response explaining how
4. If no -- decide whether it's a good idea, then ask the user how to proceed using `AskUserQuestion`

## Process

### Step 1: Read the response log

Before drafting anything, read `nimbalyst-local/social/social-response.jsonl` if it exists. Each line is a previously-approved response. Skim the last 20-30 entries for:
- **Tone calibration** -- how does the user actually phrase replies?
- **Recurring requests** -- has someone asked something similar before? What did we tell them?
- **Stock answers** -- if a feature comes up repeatedly (e.g. "how do I switch themes"), reuse and refine the prior wording.

If the file doesn't exist yet, that's fine -- proceed without it. Do not create the file at this stage; it's only written after the user approves a draft.

### Step 2: Understand the request

Read the pasted message. Extract:
- **What are they trying to do?** (the underlying goal, not just the literal words)
- **What channel are they on?** (tone shifts: Discord is casual, GitHub is more formal)
- **Is this a question, a feature request, a bug report, or general feedback?**

If the message is too vague, note that and recommend asking them a clarifying question before responding.

### Step 3: Check whether Nimbalyst already supports this

Investigate before drafting. Common moves:

- **Read `docs/FEATURE_INVENTORY.md`** -- the canonical list of what Nimbalyst can do
- **Search the docs**: `docs/`, `packages/*/CLAUDE.md`, and any topic-specific doc listed in the root `CLAUDE.md`
- **Search the codebase** with `Grep`/`Glob` for the feature, setting, or behavior they're describing
- **Check existing trackers** with `tracker_list({ search: "..." })` -- this may already be a known idea, in-progress work, or a logged decision (including a decision NOT to build it)
- **Check the changelog** (`CHANGELOG.md`) -- the feature may have shipped recently

Be honest about partial coverage: "We have X but not the Y part you're asking about" is a more useful answer than "yes" or "no".

### Step 4: Pick a path

#### Path A -- It already works

Draft a response that:
- Confirms the capability exists
- Tells them concretely how to use it (menu path, keyboard shortcut, settings location, doc link)
- Mentions any caveats or known limitations honestly
- Matches the channel's tone -- casual for Discord, more structured for GitHub

#### Path B -- It doesn't exist yet

First, form a quick opinion on whether it's a good idea. Consider:
- **Does it fit the product?** Nimbalyst is an extensible AI-native workspace and code editor. Random unrelated features don't.
- **Strategic focus alignment** -- look at the user's auto-memory `MEMORY.md` for the current week's focus. Features adjacent to that focus are more attractive.
- **Is this likely a one-person ask, or something many users would want?**
- **Is there an existing tracker decision against this?** If so, reference the reasoning.
- **Could an extension solve this** instead of core changes?

Write a short (3-5 sentence) summary for the user covering:
- What the asker wants
- Whether it exists today (and if partially, what's missing)
- Your recommendation: build it / decline it / extension territory / already decided
- Why

Then ask the user:

```
AskUserQuestion with:
- question: "How should we handle this request?"
- options:
  - "Add to tracker as a feature/idea, draft a reply saying we're considering it" - label: "Track + reply"
  - "Draft a polite decline -- not a fit"                                          - label: "Decline"
  - "Draft a reply suggesting they (or we) build it as an extension"               - label: "Extension"
  - "Just draft a reply, don't track anything"                                     - label: "Reply only"
  - "Let me think about it"                                                        - label: "Stop here"
```

Based on the choice:
- **Track + reply**: Use `tracker_create` (type `feature` or `idea`, priority `medium` unless context suggests otherwise, labels for the relevant area). Then draft a reply that thanks them, says you've added it to the backlog, and sets expectations honestly (no promises on timing).
- **Decline**: Draft a respectful response explaining why it doesn't fit. Reference the prior decision if one exists. Don't be defensive.
- **Extension**: Draft a reply pointing them at the extension system. If we have a relevant starter or example extension, link it.
- **Reply only**: Draft the reply matching whatever angle the user wants -- ask for clarification if needed.
- **Stop here**: Don't write anything. Summarize what you found and stop.

### Step 5: Deliver the response

Output the drafted response in a fenced code block so it's easy to copy. Format:

```markdown
## Response (paste this)

> [the message, ready to copy]
```

If the response should include a link to docs, a tracker item ID, or a setting path, include it inline in the message.

### Step 6: Ask if it was a good response, and log it if so

The command can't actually send the reply -- the user copies it themselves. What we can do is capture which responses the user thought were good, so future invocations can read past responses and reuse the tone, phrasing, and answers to recurring questions.

After delivering the draft, ask:

```
AskUserQuestion with:
- question: "Was this a good response?"
- options:
  - "Yes, log it"           - label: "Log it"
  - "Redraft with changes"  - label: "Redraft"
  - "Skip -- don't log"     - label: "Skip"
```

- **Log it**: Append one line to `nimbalyst-local/social/social-response.jsonl`. Create the directory and file if they don't exist. The line is a single JSON object with these fields:

  ```json
  {
    "ts": "2026-04-30T14:22:00Z",
    "channel": "discord",
    "request": "<the asker's original message>",
    "response": "<the drafted reply, exactly as delivered>",
    "path": "already-works",
    "trackerId": null,
    "topic": "paste large text inline; view sent text attachments"
  }
  ```

  Field rules:
  - `ts` -- ISO 8601 UTC timestamp
  - `channel` -- best guess from the message tone: `discord`, `github`, `twitter`, `reddit`, `email`, or `unknown`
  - `request` and `response` -- the literal strings, no truncation
  - `path` -- one of `already-works`, `track-and-reply`, `decline`, `extension`, `reply-only`
  - `trackerId` -- the tracker item ID if Path B "Track + reply" was chosen, otherwise `null`
  - `topic` -- a short (under 100 chars) human-readable label describing what the question was about, so the agent can scan past entries quickly

  Use `Bash` with `cat >> path << 'EOF'` or write the file with the `Edit`/`Write` tool. Each entry must be on a single line (JSON Lines format) -- do not pretty-print across lines.

- **Redraft**: Ask the user what to change, redraft, deliver again, and repeat Step 6.

- **Skip**: Do nothing. Don't write to the log.

Per global rules, `nimbalyst-local/` is never committed -- this log stays local to the user's machine.

## Rules

- **Match the channel's tone.** Discord = casual, friendly, lowercase-ok. GitHub Issues = more structured. Email = polite but not stiff.
- **Don't overpromise.** Never commit to ship dates, priorities, or "we'll definitely build that". The closest you can go is "added to our backlog, we'll consider it".
- **Cite specific paths.** If telling someone to flip a setting, give the menu path or keyboard shortcut, not a vague "in settings somewhere".
- **No emojis** in the drafted response unless the asker's own message used them and the channel matches that tone.
- **No "Perfect!", "Great question!", "Terrific!"** style filler. Get to the answer.
- **Be honest about limitations.** If something only half-works, say so -- it's better than promising more than the product delivers.
- **Don't invent features.** If you're not sure something exists, check the code or docs. Don't guess.
- **Don't commit anything** -- per global rules, never commit unless explicitly asked.
- **If you create a tracker item**, mention the item ID in the drafted reply only if the channel is one where tracker IDs are useful (GitHub issue cross-link, internal Discord). Skip it for public Twitter/Reddit replies.
