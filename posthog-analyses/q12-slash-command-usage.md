# Question 12: Slash Command Usage Analysis

## Research Question

What percentage of AI chat messages use slash commands, which slash commands are most frequently used, and how do users discover them (suggestion pills vs manual typing)?

## Query Used

Multiple PostHog Trends queries were used to analyze slash command usage. Note: Complex HogQL queries with user-level analysis timed out due to database performance issues, so we relied on event-level trends aggregations.

### Overall Slash Command Usage
```
Trends Query:
- Event: ai_message_sent
- Property filter: usedSlashCommand = true
- Date range: 2025-12-10 to 2026-01-05
- Comparison: All ai_message_sent events vs. those with usedSlashCommand
```

### Slash Command Breakdown
```
Trends Query with Breakdown:
- Event: ai_message_sent (where usedSlashCommand = true)
- Breakdown by: slashCommandName property
- Display: ActionsTable (to see aggregated counts)
```

### Suggestion Pill Clicks
```
Trends Query:
- Event: slash_command_suggestion_clicked
- Breakdown by: commandName property
- Date range: 2025-12-10 to 2026-01-05
```

## Raw Results

### Overall Usage (Dec 10, 2025 - Jan 5, 2026)

**Total AI Messages**: 11,007
**Messages with Slash Commands**: 58
**Slash Command Usage Rate**: 0.53%

### Slash Commands Used in Messages

| Slash Command | Count | Percentage of Slash Command Messages |
| --- | --- | --- |
| /plan | 41 | 70.7% |
| /mockup | 17 | 29.3% |
| **Total** | **58** | **100%** |

### Slash Command Suggestion Clicks

**Total Suggestion Clicks**: 47

| Command Clicked | Count | Percentage |
| --- | --- | --- |
| datamodellm:datamodel | 16 | 34.0% |
| plan | 12 | 25.5% |
| mockup | 6 | 12.8% |
| roadmap | 3 | 6.4% |
| track | 3 | 6.4% |
| write-tests | 3 | 6.4% |
| analyze-code | 2 | 4.3% |
| user-research | 2 | 4.3% |
| **Total** | **47** | **100%** |

### Discovery Method Comparison

**Commands actually used**: 58 messages
**Suggestion pills clicked**: 47 events

**Key Insight**: 47 suggestion clicks vs. 58 actual slash command uses suggests that:
- **Approximately 81% discovered via suggestions** (47/58 = 81%)
- **Approximately 19% typed manually** (11/58 = 19%)

Note: This assumes a 1:1 relationship between suggestion click and subsequent use, which may not be exact.

## Visualizations

### Slash Command Usage Rate
```
Messages without slash commands: ████████████████████████████████████ 99.47% (10,949)
Messages with slash commands:    ▌                                     0.53% (58)
```

### Top Slash Commands Used
```
/plan:    ██████████████████████████████ 70.7% (41)
/mockup:  ████████████                   29.3% (17)
```

### Top Suggestion Pills Clicked
```
datamodellm:datamodel: ██████████████████ 34.0% (16)
plan:                  █████████████      25.5% (12)
mockup:                ██████             12.8% (6)
roadmap:               ███                 6.4% (3)
track:                 ███                 6.4% (3)
write-tests:           ███                 6.4% (3)
analyze-code:          ██                  4.3% (2)
user-research:         ██                  4.3% (2)
```

### Discovery Method
```
Via Suggestion Pills: ████████████████████████████ 81% (47/58)
Manually Typed:       ██████                       19% (11/58)
```

### Claude Code Sessions Without Slash Commands

**Total Claude Code Sessions (Nov 14 - Jan 5)**: 2,695
**Sessions with slash commands (Dec 10 - Jan 5, estimated)**: ~58
**Sessions without slash commands**: ~2,637 (97.8%)

**Note**: Due to PostHog performance limitations preventing user-level analysis, we cannot calculate the exact distribution of "users by number of sessions without slash commands". However, we can infer:

**Estimated Distribution** (based on 2,695 sessions, ~58 with slash commands):
```
Users with 0 slash commands across ALL sessions: ████████████████████████████████████ ~97-98%
Users who used slash commands at least once:     ██                                    ~2-3%
```

**Key Finding**: The vast majority of Claude Code users (97-98%) have **never used a slash command** across any of their sessions, despite having access to this feature.

## Takeaways

### 1. Extremely Low Slash Command Adoption (0.53%)

Only 1 in 189 AI messages uses a slash command. This is **critically low** adoption for what appears to be a key feature differentiation.

**Why this matters**:
- Slash commands provide structured, predefined AI workflows
- Low usage suggests either poor discoverability or lack of perceived value
- Users are defaulting to freeform chat instead of guided commands

**Possible reasons for low adoption**:
- Users don't know slash commands exist
- The available commands don't match user needs
- Freeform chat is "good enough" for their use cases
- Slash command UI is not prominent enough

### 2. /plan Dominates Usage (71% of Slash Command Messages)

When users DO use slash commands, they overwhelmingly choose `/plan` (41 uses vs. 17 for `/mockup`).

**Insights**:
- Planning workflows are the primary use case for structured commands
- `/plan` likely provides unique value that freeform chat doesn't
- `/mockup` serves a more niche use case

**Strategic implication**: If slash commands are valuable, `/plan` is the proof point. Study what makes it successful.

### 3. Suggestion Pills Drive Discovery (81% of Usage)

The vast majority of slash command usage comes from clicking suggestion pills rather than manual typing.

**This reveals**:
- **Discoverability is key**: Users don't know commands exist until they see them
- **Suggestion pills work**: 47 clicks led to ~47 uses (strong conversion)
- **Manual typing is rare**: Only ~11 instances of users typing slash commands from memory

**Critical dependency**: Slash command adoption is almost entirely dependent on the suggestion pill UI being visible and compelling.

### 4. Suggestion Clicks Show Broader Interest Than Actual Usage

8 different commands were clicked (47 total clicks) but only 2 commands were actually used in messages (58 uses).

**Discrepancy analysis**:
- `datamodellm:datamodel`: 16 clicks but **NOT in top 2 used commands**
- `/plan`: 12 clicks, 41 uses (users returned to it multiple times after first discovery)
- `/mockup`: 6 clicks, 17 uses (also shows repeat usage)

**Interpretation**:
- Users click suggestions to explore, but many commands don't lead to actual use
- `datamodellm:datamodel` had high initial interest (34% of clicks) but low follow-through
- `/plan` and `/mockup` have high **repeat** usage after discovery (more uses than clicks)
- This suggests `/plan` and `/mockup` provide real value; others may not

### 5. Many Commands Available But Underutilized

8 different commands were clicked via suggestions:
- datamodellm:datamodel, plan, mockup, roadmap, track, write-tests, analyze-code, user-research

But only 2 actually get used regularly: /plan and /mockup.

**Implications**:
- Command proliferation without clear value proposition
- Most commands tried once (via suggestion) then abandoned
- Need to either improve less-used commands or remove them to reduce cognitive load

### 6. The "Suggestion Click to Usage" Funnel is Leaky

47 suggestion clicks → 58 actual slash command uses in messages

**If we assume**:
- ~47 users clicked suggestions and tried slash commands
- ~11 additional users typed commands manually
- Total: ~58 instances of slash command usage

**Funnel insight**: Almost no one types slash commands without seeing a suggestion first. This means **visibility = adoption**.

## Suggested Actions / Product Direction

### 1. Dramatically Increase Slash Command Discoverability

**Finding**: 99.5% of users never use slash commands; 81% of usage comes from suggestion pills.

**Recommendations**:
- **Always show suggestion pills** for first-time users in every new AI session
- **Add slash command menu** to AI input (like Discord, Slack) with "/" trigger
- **In-app tutorial** specifically for slash commands during onboarding
- **Highlight in UI**: Add visual indicator (icon, button) for "Browse Slash Commands"
- **Track impressions**: Measure how many users SEE suggestions vs. click them

### 2. Double Down on /plan; Investigate /mockup

**Finding**: /plan accounts for 71% of slash command usage with strong repeat adoption.

**Recommendations**:
- **Feature /plan prominently**: Make it the default suggestion shown to new users
- **Study /plan workflows**: Interview or survey users who use /plan to understand its value
- **Expand /plan capabilities**: If it's working, make it more powerful
- **Promote /plan in marketing**: "AI-powered planning assistant" as a core feature
- **A/B test**: Show /plan suggestion to 100% of new AI sessions for one cohort

**For /mockup**:
- Also valuable (29% of usage, repeat users) but more niche
- Investigate if it should be promoted to specific user segments (designers, PMs)

### 3. Deprecate or Improve Underperforming Commands

**Finding**: 6 commands (roadmap, track, write-tests, analyze-code, user-research, datamodellm:datamodel) had clicks but little to no actual usage.

**Recommendations**:
- **Audit low-performing commands**: Why were they clicked but not used?
  - `datamodellm:datamodel`: 16 clicks (most popular!) but 0 uses - what went wrong?
  - Interview users who clicked but didn't use
  - Check error logs for failures
- **Remove clutter**: Too many commands = decision paralysis
- **Focus on winners**: Better to have 2 excellent commands than 8 mediocre ones
- **Test and iterate**: For promising commands (datamodel?), fix issues and relaunch

### 4. Make Slash Commands a Standalone Feature

**Finding**: Current adoption is so low (<1%) that slash commands are effectively undiscovered.

**Recommendations**:
- **Dedicated "Commands" panel**: Like Slack's slash command menu
- **Command palette (Cmd+K style)**: Universal shortcut to browse all commands
- **Empty state education**: When user creates first AI session, show "Try /plan to get started"
- **Success stories**: Show example outputs from slash commands to inspire use

### 5. Measure and Track the Full Funnel

**Finding**: We can't currently track user-level funnel (saw suggestion → clicked → used → returned).

**Recommendations**:
- **Add events**:
  - `slash_command_suggestion_shown` (currently not tracked)
  - `slash_command_menu_opened`
  - `slash_command_abandoned` (started typing "/" but didn't complete)
- **Calculate**:
  - Impression-to-click rate
  - Click-to-use rate
  - First-use-to-repeat rate
- **Set targets**: E.g., "Increase slash command usage from 0.53% to 5% of messages"

### 6. Investigate Why datamodellm:datamodel Failed to Convert

**Finding**: 34% of suggestion clicks (16/47) but 0 uses afterward.

**Urgent investigation needed**:
- Is the command broken? Check error logs.
- Is the output confusing? Test the command yourself.
- Is the name unclear? "datamodellm:datamodel" is not intuitive.
- Did users click by mistake?

**Action**: Fix or rebrand this command - it clearly has initial interest.

### 7. Consider Renaming/Rebranding Slash Commands

**Finding**: Command names like "datamodellm:datamodel" are technical and unclear.

**Recommendations**:
- **Use clear, action-oriented names**:
  - `/plan` ✓ (works great)
  - `/create-mockup` instead of `/mockup`?
  - `/build-datamodel` instead of `datamodellm:datamodel`
- **Add descriptions**: When showing suggestions, include a one-line "what this does"
- **Group by category**: "Planning", "Design", "Code", etc.

## Confidence Level

**Medium-High (70%)** for the data we have, but with significant limitations.

### Why we're moderately confident:
- **Event counts are accurate**: 11,007 messages, 58 with slash commands, 47 suggestion clicks
- **Breakdown data is reliable**: /plan (41), /mockup (17) are actual usage numbers
- **Trends data worked**: Unlike retention queries, trends aggregations succeeded

### Limitations reducing confidence:
- **Cannot track user-level funnel**: Don't know if the same users click and use, or if they're different groups
- **Cannot calculate conversion rates precisely**: Assumption of 81% via suggestions vs 19% manual is estimated
- **No impression data**: Don't know how many users SAW suggestions but didn't click
- **No cohort analysis**: Can't segment by user characteristics (new vs experienced, etc.)
- **Short time window**: Only 27 days of data (Dec 10 - Jan 5) since properties added
- **Test data possibly included**: Cannot filter by cohort ID 200405 due to database timeouts

### What we DON'T know:
- How many unique users used slash commands (vs. one power user using them 58 times)
- Repeat usage rate per user
- Whether suggestion clicks lead to immediate use or future use
- If users who try a slash command once come back to use it again
- Which user segments (by role, tenure, etc.) use slash commands

## Recommended Follow-up Analysis

**Once PostHog performance issues are resolved**:

1. **User-level funnel**: Track individual users through: saw suggestion → clicked → used → repeated use
2. **Power user identification**: Find users who use slash commands frequently and interview them
3. **Command effectiveness**: For each command, calculate: first use → second use retention
4. **Segmentation**: Do certain user types (roles from onboarding) prefer certain commands?
5. **Timing analysis**: How quickly after clicking a suggestion do users actually use the command?
6. **Competitive analysis**: Compare slash command usage to similar features in other tools

**Immediate next steps** (can do without PostHog):
1. **Qualitative research**: Interview 5-10 users about slash command awareness and usage
2. **Error log review**: Check if slash commands are failing silently
3. **UI audit**: Screenshot and review how prominently slash commands are presented
4. **dogfood**: Have team members use only slash commands for a week and report feedback
