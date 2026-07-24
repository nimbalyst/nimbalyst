# Extension Ideas


## Current Ideas

- Sitemap builder -> screenshot keep up to dater
- Mockups (exists, but not as a plugin)
- Datamodels (exists as a core plugin)
- Excalidraw (exists somewhat, but not at all AI integrated)
- Playwright manager
- Video shorts recorder for your app (using playwright)
- 3d Object Viewer / Editor
- File tree customizer (icons, colors, hidden folders, favorites, etc)
- Theme Plugins
- Meeting note taker (audio to document, with organization)
- Mindmap / brainstormer
- Calendar
- Timeline
- AI Image designer / nanobanana
- Namenym - name brainstormer and analyzer
- Kanban

## Expanded Ideas (March 2026)

Researched against top VSCode extensions (173M+ Python, 48M Prettier, 42M GitLens, 41M Copilot, 8M Thunder Client), top Obsidian plugins (3.8M Dataview, 2.4M Calendar, 2.2M Kanban/Style Settings, 1.9M Iconize, 1.3M Omnisearch), and top Claude Code MCP servers (Context7, GitHub, Sentry, Linear). Each idea notes the **Nimbalyst advantage** -- why it's better here than in VSCode/Obsidian.

Full detailed breakdown with priority tiers is in `plans/extension-marketplace-and-ideas.md`.

### Diagrams & Visual Editing
- **Mermaid WYSIWYG Editor** -- Visual drag-and-drop node editing, not just preview. AI generates mermaid from descriptions. (VSCode Mermaid Preview: 2M+)
- **PlantUML Editor** -- Rich UML canvas with bidirectional code<->visual editing. AI generates UML from codebase analysis. (VSCode PlantUML: 1.5M)
- **Flowchart Builder** -- Drag-and-drop with smart connectors. AI generates flowcharts from process descriptions or code logic. (Draw.io: 3M VSCode)
- **Org Chart / Hierarchy Visualizer** -- Visual org charts from structured data. AI builds from team descriptions.
- **Network Topology Diagrammer** -- Standard infrastructure icons. AI generates from Terraform/CloudFormation.
- **D3 Chart Designer** -- Interactive chart creation (bar, line, scatter, treemap, force-directed). Custom editor with live data binding.
- **ASCII Art / Box Drawing** -- Visual editor for ASCII diagrams. AI converts descriptions to ASCII art for READMEs.
- **Wireframe Kit** -- Lighter-weight MockupLM focused on wireframing speed with AI layout suggestions.
- **SVG Editor** -- Visual SVG path editor with node manipulation. Custom editor for `.svg` files with source toggle.
- **Slide Deck Presenter** -- Markdown-to-reveal.js presentations with speaker notes. AI helps with layout/content. (Obsidian Advanced Slides: 813K)
- **Timeline / Gantt Editor** -- Visual timeline and Gantt from structured data. AI generates project timelines.
- **Map Viewer** -- Geographic map with markers from geo-tagged data. (Obsidian Map View: 310K)

### Data & Spreadsheets
- **JSON/YAML Visual Editor** -- Tree-view and form-based editing with schema validation. AI can transform/query/restructure.
- **Parquet/Arrow Viewer** -- View columnar data formats with filtering and statistics. (VSCode Data Preview)
- **SQL Notebook** -- Jupyter-style notebooks for SQL with inline results and charts. AI writes and explains queries.
- **GraphQL Explorer** -- Interactive query builder with schema introspection. AI generates queries from natural language.
- **Regex Tester** -- Visual regex building with explanation and match highlighting. AI explains and generates patterns.
- **Log Viewer** -- Structured log viewing with filtering, timestamp parsing, pattern detection. AI identifies error patterns.
- **Excel/XLSX Editor** -- Full spreadsheet editing with formula support, not just CSV. (VSCode Excel Viewer: 5M)
- **Database Schema Visualizer** -- ERD from Prisma/Drizzle schemas or live DB connections. AI suggests improvements.

### Developer Tools
- **HTTP Client** -- `.http` file-based requests (git-committable). AI generates from API docs or curl. Response as formatted JSON. (VSCode REST Client: 6M, Thunder Client: 8M)
- **Docker Compose Visualizer** -- Visual diagram of services/networks/volumes with health status. Bidirectional editing. (VSCode Docker: 46M)
- **OpenAPI / Swagger Editor** -- Visual API design with schema editor and live preview. AI generates endpoints from descriptions.
- **Terraform Visualizer** -- Resource dependency graph from `.tf` files. AI helps write configs. (VSCode Terraform: 5M)
- **CI/CD Pipeline Editor** -- Visual editor for GitHub Actions/CircleCI/GitLab CI. Drag-and-drop steps. (VSCode GitHub Actions: 2M)
- **Dependency Graph** -- npm/pip/cargo dependency tree with vulnerability indicators. AI suggests updates.
- **Environment Manager** -- Visual `.env` editor with secret masking and cross-env comparison. AI identifies missing vars.
- **Cron Expression Builder** -- Visual schedule builder. AI translates natural language to cron syntax.
- **Changelog Generator** -- Auto-generate from git history with conventional commit parsing. AI summarizes.
- **Monorepo Navigator** -- Visualize workspace package relationships and build order. AI assists cross-package refactoring.
- **Port Scanner / Service Monitor** -- Dashboard of running local services and ports.
- **Snippet Manager** -- Personal code snippet library with tagging and search. AI categorizes.
- **Error Lens** -- Inline error/warning display at end of lines. AI explains and fixes. (VSCode Error Lens: 10M)
- **GitHub integration** -- PR management, Actions status, review queue panel. (GitHub MCP: 3.1M installs)
- **Xcode project helper** -- Team ID, simulators, iOS versions.

### AI-Enhanced Tools
- **Context7 / Doc Injector** -- Inject version-specific library docs into AI context. (Top Claude Code MCP server)
- **AI Prompt Library** -- Curated prompt templates integrating with slash commands. Community-shared.
- **Token / Context Visualizer** -- Visual breakdown of context window usage by category.
- **Smart Connections** -- AI-powered semantic linking that surfaces related documents across workspace. (Obsidian Smart Connections: 852K)
- **AI Code Review** -- Automated review on staged changes with security/performance/style analysis.
- **Test Generator** -- AI-generated unit tests matching project testing patterns. (EarlyAI: rising VSCode)
- **Documentation Generator** -- Auto-generate API docs, JSDoc, README sections from code.
- **Meeting Notes Transcriber** -- Audio-to-document with summarization and action item extraction. (Granola-style)
- **AI Writing Assistant** -- Inline suggestions, grammar checking, tone adjustment in Lexical. (Obsidian Text Generator: 500K)
- **Codebase Q&A** -- RAG-based chat about the current codebase with file references. (Sourcegraph Cody: 1M VSCode)
- **Project memory system** -- Hashtag-based context for AI sessions.
- **File size awareness** -- Flag large files for splitting.

### Knowledge Management
- **Wiki Links / Backlinks** -- `[[wiki-style]]` linking with backlink panel. Lexical integration. AI suggests links. (Obsidian core, Foam: 500K VSCode)
- **Graph View** -- Interactive force-directed graph of document links. AI identifies clusters. (Obsidian core)
- **Dataview / Query Engine** -- Query workspace files by frontmatter, tags, dates. Render as tables. (Obsidian Dataview: 3.8M)
- **Tag Manager** -- Bulk rename, merge, organize tags. AI suggests taxonomies. (Obsidian Tag Wrangler: 907K)
- **Daily Notes / Journal** -- Calendar navigation, templates, periodic reviews. AI summarizes activity. (Obsidian Calendar: 2.4M + Periodic Notes: 750K)
- **Readwise / Highlights Sync** -- Import highlights from Kindle, web, PDFs. AI synthesizes themes. (Obsidian Readwise: 300K)
- **Zettelkasten System** -- Fleeting/literature/permanent note workflow. AI refines notes.
- **Omnisearch** -- Full-text search across all file types including PDFs/images via OCR. (Obsidian Omnisearch: 1.3M)
- **Bookmarks / Favorites** -- Quick-access panel for pinned files and line locations. (VSCode Bookmarks: 4M)

### Project Management & Productivity
- **Kanban Board** -- Markdown-backed boards. AI auto-triages and suggests priorities. (Obsidian Kanban: 2.2M)
- **Pomodoro Timer** -- Focus timer with session notes. Auto-links to active files.
- **OKR / Goal Tracker** -- Structured OKR tracking with progress dashboards. AI helps write OKRs.
- **Standup Report Generator** -- Auto-generate from git activity + tracker items + calendar.
- **Time Tracker** -- Automatic tracking by active files with reporting. Export for invoicing. (WakaTime: 22M VSCode)
- **Habit Tracker** -- Daily tracking with streaks and contribution heatmaps.
- **Sprint Board** -- Agile sprint planning with velocity charts and burndown. Integrates with Linear/GitHub.

### Integrations
- **Linear Integration** -- Visual panel with board views and AI-powered issue creation. (Already have Linear MCP)
- **Slack Notifier** -- Send/receive messages, share code with syntax highlighting.
- **Notion Sync** -- Bidirectional sync between markdown and Notion pages.
- **Obsidian Vault Compat** -- Read/write Obsidian vaults with wiki links and callouts. Migration opportunity.
- **Google Docs Import/Export** -- Bidirectional with formatting preserved.
- **Webhook Manager** -- Visual webhook config, testing, and logging.
- **RSS Feed Reader** -- Subscribe to feeds, read inline, save to workspace.
- **Todoist / Things Sync** -- Bidirectional task sync. (Obsidian Todoist: 550K)
- **Apple Shortcuts / Automator** -- Bidirectional automation bridge.
- **Sentry Error Browser** -- View errors, link to source, create issues. AI diagnoses. (Sentry MCP)

### Writing & Documents
- **Document templates library** -- Pre-built templates for common document types.
- **Longform / Novel Writer** -- Chapter-based manuscript management. AI helps with continuity. (Obsidian Longform: 450K)
- **Academic Paper Writer** -- LaTeX math, citations, bibliography. AI assists literature review.
- **Blog Publisher** -- Publish to Medium, Dev.to, Ghost, WordPress. AI optimizes per platform.
- **Translation Helper** -- AI translation preserving markdown formatting and technical terms.
- **Pandoc Export** -- One-click export to Word, PDF, LaTeX, ePub. (Obsidian Pandoc: 480K)
- **Review/commenting system** -- AI-assisted document review with inline annotations.
- **Citation Manager** -- BibTeX/CSL management with Lexical insertion plugin.
- **Typewriter Mode** -- Focused writing with centered line and fading context.
- **Spell Checker / Linter** -- Grammar and style checking. Code-aware (camelCase). (VSCode Spell Checker: 8M, Obsidian Linter: 833K)

### Themes & Appearance
- **Theme Studio** -- Visual theme designer with live preview of all `--nim-*` variables. (Obsidian Style Settings: 2.2M)
- **Icon Pack Manager** -- Material, Catppuccin, Seti icon packs. (VSCode Material Icons: 20M, Obsidian Iconize: 1.9M)
- **Font Manager** -- Browse and preview fonts. AI suggests pairings.
- **Catppuccin Theme** -- Popular pastel theme (Latte, Frappe, Macchiato, Mocha).
- **Dracula Theme** -- Dark theme with vibrant colors.
- **Nord Theme** -- Arctic-inspired palette.
- **One Dark Pro** -- Atom's iconic dark theme. (15M+ VSCode)
- **Monokai Theme** -- Classic Monokai scheme.

### Media & Creative
- **Color Palette Generator** -- AI generates palettes from descriptions, exports to CSS/Tailwind.
- **Icon Library Browser** -- Search Lucide, Heroicons, Font Awesome. Click to insert.
- **Image Optimizer** -- Compress, resize, convert images in-place with before/after preview.
- **Audio Waveform Viewer** -- Visualize and annotate audio files.
- **QR Code Generator** -- Generate QR codes from text/URLs with customization.
- **Markdown Badge Generator** -- Generate shields.io badges for README files.

### DevOps & Infrastructure
- **Kubernetes Dashboard** -- Cluster visualization with pod status and logs. (VSCode Kubernetes: 5M)
- **AWS Resource Browser** -- S3, Lambda, DynamoDB, CloudWatch access. (VSCode AWS Toolkit: 2M)
- **Cloudflare Dashboard** -- Manage Workers, Pages, D1, R2 from editor.
- **Server Monitor** -- Real-time server metrics dashboard.

### Mobile & IoT
- **HomeKit Controller** -- Visual panel with room layouts and device controls. (Already have MCP)
- **MQTT Dashboard** -- Connect to brokers, subscribe to topics, visualize messages.
- **Bluetooth LE Explorer** -- Scan and interact with BLE devices.
- **3D Model Viewer** -- OBJ/GLTF/STL viewing. (nimbalyst-three-d exists)

### Finance & Business
- **Invoice Generator** -- Professional invoices with PDF export. AI auto-fills from project data.
- **Expense Tracker** -- Project expenses with categorization and chart reports.
- **Stock / Crypto Ticker** -- Real-time price display with charts.

### Education & Learning
- **Flashcard System** -- Spaced repetition from notes/code. AI generates flashcards. (Obsidian Spaced Repetition)
- **Interactive Tutorial Builder** -- Step-by-step coding tutorials with executable examples.
- **Code Playground** -- Run code snippets in sandboxed environments. (VSCode Code Runner: 10M)

### Nimbalyst-Unique Opportunities
These leverage capabilities no other editor has:

- **Session Analytics Dashboard** -- Visualize AI session patterns, cost tracking, productivity metrics. Only Nimbalyst tracks sessions this deeply.
- **Workstream Burndown** -- Multi-session project tracking with velocity metrics. Workstream architecture is unique.
- **Extension Builder** -- Build extensions for Nimbalyst inside Nimbalyst. Dog-food the system.
- **AI Session Replay** -- Replay sessions step-by-step for review or tutorials. Transcript data is uniquely rich.
- **Cross-File Refactoring Visualizer** -- Visualize refactoring impact before committing. Combines file watcher + diff + AI.
- **Document-First API Designer** -- Write API docs in Lexical, AI generates OpenAPI spec + implementation.
- **Multi-Format Note Hub** -- Single note embedding multiple editor types inline (markdown + spreadsheet + diagram).
- **AI Pair Programming Replay** -- Record and share human+AI coding sessions for learning/teaching.
- **Workspace Template Marketplace** -- Pre-configured workspace setups with file structure, extensions, and AI prompts.
- **AI-Powered File Organization** -- AI suggests organization, detects duplicates, proposes folder improvements.

## Nimbalyst Strengths for Extensions

Extensions that leverage these core capabilities are likely to be most successful:

1. **Bidirectional custom editors** -- WYSIWYG for traditionally code-based formats (the single biggest differentiator vs VSCode/Obsidian)
2. **Deep AI integration** -- Extensions can expose MCP tools, use AI chat completions, and hook into the agent workflow
3. **Rich text (Lexical)** -- Structured rich text editing that no code editor offers
4. **Session + workstream tracking** -- Unique metadata about AI-assisted work over time
5. **Git-aware** -- Extensions that integrate with version control
6. **Local-first** -- Privacy-focused tools that work without cloud dependencies
7. **Cross-platform** -- Extensions targeting both desktop (Electron) and mobile (iOS/Capacitor)

## Priority Tiers

**Tier 1 -- Build ASAP (massive demand, strong Nimbalyst advantage):**
1. Theme Pack (Catppuccin, Dracula, Nord, One Dark) -- Low effort, high install count
2. HTTP Client (.http files + AI) -- Thunder Client has 8M installs
3. Wiki Links + Backlinks -- Obsidian's core draw, millions of users
4. Mermaid WYSIWYG -- 2M+ VSCode installs, custom editor makes it visual

**Tier 2 -- Build Soon:**
5. JSON/YAML Visual Editor
6. Docker Compose Visualizer
7. Slide Deck Presenter
8. Daily Notes / Calendar

**Tier 3 -- Build for Differentiation:**
9. Session Analytics Dashboard
10. AI Prompt Library
11. Extension Builder
12. 3D Model Viewer (nimbalyst-three-d already exists)
