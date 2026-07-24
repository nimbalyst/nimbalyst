# Claude Code for Product Managers

*Understand your codebase and make better product decisions with AI that works directly with your actual code.*

Unlike ChatGPT or Claude, which only work with copy-pasted snippets, Claude Code runs locally and accesses your entire repository, file structure, and git history.

## Getting Started

Ask your engineering team for read-only access to your product's repository. Clone it locally using GitHub Desktop or similar tools. You can explore and ask questions without risk of changing production code.

## Key Capabilities

- Direct access to your entire codebase and git history
- Searches across all files and dependencies
- Understands your complete file structure and architecture
- Executes commands and shows actual output

## Essential Use Cases

### Investigate Features and Issues

Understand how features work without interrupting your engineering team:
- Trace through authentication flows, payment logic, or API endpoints
- Search for error messages users reported
- Check validation rules and why users get blocked
- Determine if something is a bug, UX issue, or hidden feature

**Example**: User reports crashes uploading photos. Claude Code reveals a 5MB limit—a UX problem about communicating the limit, not a bug.

### Make Informed Decisions

Validate assumptions before writing specs:
- Check existing capabilities and infrastructure
- Understand technical constraints and complexity
- Identify what data and systems are available
- Assess feasibility of requested features

**Example**: Marketing wants social media sharing. Claude Code finds existing OAuth code and preview image generation, making the feature more feasible than expected.

### Plan Better

Create plans aligned with your actual codebase:
- Understand existing patterns and architecture
- Reference actual components in your specs
- Identify technical debt affecting velocity
- Prepare for discussions with specific, informed questions

**Example**: Engineering estimates 8 points for a "simple" profile update. Claude Code shows profile data scattered across three services with complex validation, explaining the estimate.

## What You'll Do

You're not becoming an engineer. You'll:
- Read code to understand how things work
- Ask questions about your system's capabilities
- Investigate issues before escalating
- Make informed product decisions

## Example Questions

Ask Claude Code like you would an engineer:
- "Show me how our checkout flow works"
- "Where do we store user preferences?"
- "What validation rules exist for email addresses?"
- "Find all places where we send email notifications"

## Benefits

- Fewer interruptions for your engineering team
- Faster answers about your product
- Better-informed decisions and planning
- More effective communication with technical stakeholders
