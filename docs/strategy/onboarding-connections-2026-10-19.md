# ros.ai onboarding: find and connect your tools

19 October 2026 · Snapshot taken 19 October 2026 of the Claude Doc https://claude.ai/code/artifact/80419630-4641-42d2-b4b0-633fa099a12e, which stays the living version; edit the doc, not this file. Design for the first launch of the local app, in answer to Adam's ask of 19 October 2026: find the agents, models and apps already on the computer, show them as one list of recommended connections, and link them in the background once the person agrees. The screen mockup (three boards: first launch, states after Connect, the Agents page afterwards) is the design artifact https://claude.ai/artifact/13gd9Rh6fiZzfrBZkHvgpX. The two drawings live in the doc and are described in text here. Written against `main` at cbaba92; nothing in this file is built yet.

## Recommendation

Make the first launch one screen: what ros.ai found on this computer, pre-ticked, with one **Connect** button. Agents link silently in the background, models register silently, and apps follow with one click each because their providers insist on it.

- **Agents found** (Claude Code, Codex, Cursor, Gemini CLI, Claude Desktop) are linked by registering ros.ai's own MCP server in each agent's settings, through the agent's own command (`claude mcp add`, `codex mcp add`). The agent keeps its own login; ros.ai never sees it.
- **Models found** (keys in the environment, Ollama, LM Studio) are registered without spending anything; the free hosted Ros takes one approval in the browser.
- **Apps found** (Notion, Slack, GitHub, later Linear and Figma) each need one OK on the provider's page, so they run after the silent links, one click per app. Zotero and a synced Google Drive folder need no OK at all.
- **Nothing leaves the computer**, nothing is written until Connect, every link has Undo, and *Choose one by one* is the manual path. The same rows live on the Agents and Apps pages afterwards, so onboarding is the first showing of those pages, not a separate wizard.

Before the 24 October freeze: the agents and models slice (detection, the screen, silent links, undo), about two days, additive, with no change to tools, blocks or prompts. It gives the demo video its opening shot: ros.ai finds Claude Code and Codex on the Mac and both work on the same canvas a minute later. After 30 October: apps through remote MCP servers with OAuth, one client that replaces pasted tokens.

## Principles

The screen should feel like recognition ("it knows my setup"), not like a setup wizard. Seven rules follow from the product's promise, the open workspace where you direct AI agents, and from how Adam wants the app to behave.

1. **One screen, one decision.** A list of what was found, pre-ticked, one primary button. Everything else sits behind *Choose one by one*.
2. **Nothing leaves the computer.** Detection is local and read-only: existence, version and names, never credentials. No telemetry, no call to ros.ai cloud. The screen says in one line what was looked at.
3. **Nothing is written without a click.** Agent settings change only after Connect, only by adding one `ros-ai` entry, with a record of what was written and an Undo on every row.
4. **The user's agents keep their own logins.** ros.ai registers itself as a tool in Claude Code or Codex; it never copies or drives their sign-in (the 8 October decision, and the rule not to copy AIPOCH's subscription login).
5. **One mechanism per kind.** Agents: MCP registration. Apps: MCP servers with OAuth. Models: ordinary model connections. New tools then join by adding a catalogue entry, not a new flow.
6. **Onboarding is the first view of the Agents and Apps pages.** No capability exists only in onboarding; a skipped row can be connected later from the same place, and a tool installed later appears there as a quiet suggestion.
7. **Honest states.** *Linked* means the setting was written; *Seen* means the agent actually called ros.ai; *Waiting for you* names the tab to finish in; *Couldn't connect* shows the paste-able command. Status is a dot and a word, green only when real.

## Three kinds of link

"Linking" means three different things in ros.ai, and only the first and third can be fully silent. The table says which direction each link runs, how it is made and what the repo already has.

| Kind | Direction | How the link is made | Silent in the background? | In the repo today |
| --- | --- | --- | --- | --- |
| Your own agents | agent → ros.ai | ros.ai's MCP server registered in the agent: `claude mcp add`, `codex mcp add`, `gemini mcp add`, or one entry merged into Cursor's and Claude Desktop's JSON settings | Yes, under a second per agent | `POST /mcp` with a per-start token, the stdio bridge `scripts/ros-ai-mcp.mjs`, commands to copy on the Agents page, sessions listed per agent |
| Agents as ros.ai's workers | ros.ai → agent | Claude Code through the Agent SDK on an Anthropic API key; Codex through its app-server sign-in | Keys from the environment, yes; a sign-in needs one approval | Both on the Agents page; keys in the environment already count as configured |
| Apps | ros.ai → app | A remote MCP server with OAuth (Notion, Slack, GitHub, Linear, Figma); a local API (Zotero); a synced folder (Google Drive, Dropbox, OneDrive); a pasted token as fallback | One OK on the provider's page per app; local APIs and folders are silent | Pasted tokens for Zotero, Slack, Notion and GitHub; Google Drive OAuth with the user's own Google client; none usable by Ros yet |
| Models for Ros | ros.ai → model | A key connection, a loopback server, or the hosted Ros sign-in | Keys and local servers, yes; the sign-in needs one approval | `tool-credentials.ts` reads environment keys; `inference-connections.ts` holds loopback servers; `cloud-account.ts` signs in with a device code |

The promise "do it in the background when the user agrees" holds completely for agents and models. For apps it holds up to the provider's consent page, which no client may skip; the design therefore sequences apps after the silent work instead of pretending otherwise.

## Detection: what ros.ai can find, and how

The local server does the looking, not the browser page: a page cannot see the file system, and the hosted demo has no computer to look at. Every check is an existence test, a version string, a modification time or a name read from agent settings; the whole scan takes well under a second and sends nothing anywhere.

| Tool | What counts as found (macOS paths; Windows and Linux use the same dot-folders under the user profile) | Signal strength | What it enables |
| --- | --- | --- | --- |
| Claude Code | `claude` on PATH or in `~/.local/bin`, Homebrew or npm bin; folder `~/.claude/`; file `~/.claude.json` (user-scope MCP servers) | binary = installed; folder = used; recent change = used recently | Link as an outside agent. As a worker it needs an Anthropic key |
| Claude Desktop | `/Applications/Claude.app`; `~/Library/Application Support/Claude/claude_desktop_config.json` | app present | Link with one entry in that file (restart needed) |
| Codex | `codex` on PATH; folder `~/.codex/` with `config.toml`; `auth.json` present means signed in (existence only); `/Applications/Codex.app` reads the same `config.toml` (community report, verify on a Mac) | as above | Link as an outside agent. The worker path's sign-in already exists |
| Cursor | `/Applications/Cursor.app`; `~/.cursor/mcp.json` | app = installed; file = MCP already in use | Link with one entry in `mcp.json` |
| Gemini CLI | `gemini` on PATH; `~/.gemini/settings.json` | binary | `gemini mcp add` |
| Windsurf, VS Code, Zed, OpenCode | app bundle or binary; their MCP settings files | app present | Later, same JSON merge |
| Names in agent settings | `mcpServers` keys and URL hosts in `~/.claude.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json`; nothing else from those files | strongest signal for apps: the person already uses Notion or GitHub from an agent | Recommend those apps first, with the line "your Claude Code already reaches Notion" |
| Notion | `/Applications/Notion.app`; a `notion` server in agent settings | installed; used | Sign in with Notion (hosted MCP server) |
| Slack | `/Applications/Slack.app` | installed | Sign in with Slack (hosted MCP server, see mechanics) |
| GitHub | `gh` on PATH and `~/.config/gh/hosts.yml` present; `github.com` remotes in project folders | signed in to `gh`; used | Sign in with GitHub (hosted MCP server) or a token |
| Zotero | `/Applications/Zotero.app`; `~/Zotero/`; local API answering on `127.0.0.1:23119` | installed; API on = instant | Read the library through the local API, no key at all |
| Google Drive | `/Applications/Google Drive.app`; `~/Library/CloudStorage/GoogleDrive-*` | synced folder present | Read synced files as local files; OAuth only for what is not synced |
| Dropbox, OneDrive, iCloud Drive | `~/Library/CloudStorage/*`, `~/Dropbox` | folder present | Same as Drive |
| Obsidian | `/Applications/Obsidian.app`; vault paths in `~/Library/Application Support/obsidian/obsidian.json` | vault paths | Offer a vault as a project folder |
| Linear, Figma | `/Applications/Linear.app`, `/Applications/Figma.app` | installed | Later, hosted MCP servers |
| Keys in the environment | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `NEBIUS_API_KEY`, `TAVILY_API_KEY` (read today); later `GEMINI_API_KEY`, `OPENROUTER_API_KEY` | present (value never shown) | Already count as configured; the screen only says so |
| Ollama | `/Applications/Ollama.app`, `ollama` on PATH, `GET 127.0.0.1:11434/api/tags` | running, with its model list | Register a loopback connection with those models |
| LM Studio | `/Applications/LM Studio.app`, `GET 127.0.0.1:1234/v1/models` | running | Same |
| Docker | `docker` on PATH, `/Applications/Docker.app`, the engine socket | engine running | Code and Notebook blocks can run; otherwise the screen names what to install |

**Never read:** the contents of `~/.codex/auth.json` or `~/.claude/.credentials.json`, the keychain, `env` or `headers` values inside MCP settings, shell start-up files, browser profiles, chat histories. A found app is a hint, not proof of use, so rows sort by signal (used recently, used, installed) and the screen shows at most six, the rest behind *More found*.

One limit to design for now: when ros.ai is later launched from an app icon instead of a terminal, shell environment variables are not inherited, so the keys row offers *Paste a key*. Capturing the login shell's environment once, as VS Code does, is possible but runs the person's shell files, so it stays an opt-in setting.

## The flow

First launch shows one screen before the question box. After **Connect**, the silent links finish within a second or two, apps wait for one click each, and the question box follows. Later launches never show the screen again; a tool installed afterwards appears on the Agents page as a quiet suggestion.

1. **Start.** ros.ai starts, scans (under a second) and opens the browser. If nothing but the hosted Ros would be listed, the screen is skipped and the sign-in is asked when the first question is sent, as today.
2. **The screen, "Connect your tools".** Three groups: Agents, Ros (what it thinks with), Apps. Each found row is pre-ticked and carries a logo, one consequence line ("Adds ros.ai to Claude Code's tools. Your Claude login stays yours.") and its signal ("found · signed in"). A Docker line is information only. Primary button **Connect 5**, secondary **Not now**, link *Choose one by one*. Footer: "Looked at Applications, your PATH and agent settings on this Mac. Nothing was sent anywhere. What ros.ai looked at."
3. **Connecting.** Agent and model rows flip to *Connected* in parallel within a second or two. Each app row shows **Continue in Notion**: browsers allow one new tab per click, so ros.ai cannot chain consent pages, and each click opens its provider's page. Hosted Ros shows its code and **Open the sign-in page**.
4. **Done.** The button becomes **Start**; rows still waiting can be finished later from Agents or Apps. One hint line: "Claude Code and Codex are linked. In a new session, try: Open my ros.ai project and summarise the canvas."
5. **Failure.** A row that could not be linked (CLI not on the server's PATH, settings file unreadable) shows the paste-able command or the file path, never an error dump, and nothing else is held up.
6. **Manual.** *Choose one by one* turns the list into the Agents and Apps rows with their own buttons: Connect, Copy command, Sign in, Paste a token.
7. **Afterwards.** Agents and Apps show each row's state: *Linked 19 Oct · Seen 2 min ago · Undo*. A tool installed later shows "Codex appeared on this computer. Link it?" at the top of Agents; a removed one reads "Not found on this computer any more".

*Drawing in the doc (described):* a left-to-right flow. Start leads to the scan (under a second) and to the screen. From **Connect** the lanes run side by side: agents and models link silently and flip to *Connected* within a second or two; each app detours through its provider's page for one OK and comes back as *Connected* or stays *Waiting for you*. *Not now* goes straight to the question box. All lanes rejoin at **Start** and the question box, and the Agents and Apps pages hold the same rows afterwards.

Agents and models finish on their own; each app detours through its provider's page for one OK; *Not now* goes straight to the question box.

## Linking mechanics

Every agent link is one entry named `ros-ai` that points at a bridge living in ros.ai's data folder, made with the agent's own command where one exists. Verification is the agent's first real call, and Undo removes exactly that entry.

| Agent | Command or file ros.ai uses | Verify | Undo | Notes |
| --- | --- | --- | --- | --- |
| Claude Code | `claude mcp add --scope user ros-ai -- node <bridge>` | `claude mcp get ros-ai`; *Seen* on the first `initialize` | `claude mcp remove --scope user ros-ai` | New sessions see it; an open session reconnects with `/mcp` |
| Codex (CLI and app) | `codex mcp add ros-ai -- node <bridge>` | `codex mcp list` | `codex mcp remove ros-ai` | The app reads the same `config.toml`; confirm on a Mac that has it |
| Gemini CLI | `gemini mcp add ros-ai node <bridge>` (confirm the syntax with `--help`) | `gemini mcp list` | `gemini mcp remove ros-ai` |  |
| Cursor | Merge `mcpServers.ros-ai` into `~/.cursor/mcp.json`; the manual path can also offer the deeplink `cursor://anysphere.cursor-deeplink/mcp/install?name=ros-ai&config=<base64>` | Re-read the file; *Seen* | Remove the key | A 2026 forum report says the deeplink card can fail in Cursor 3.15, so the file merge is the reliable route |
| Claude Desktop | Merge into `claude_desktop_config.json` | *Seen* after a restart | Remove the key | Needs an app restart; the row says so |
| Windsurf, VS Code, Zed | Same merge into their settings files |  |  | Later |

**The bridge.** Today the commands point at `scripts/ros-ai-mcp.mjs` inside the checkout, so a moved or updated install breaks every link. Write the bridge into the data folder at each start next to `mcp.json` (`<data>/bin/ros-ai-mcp.mjs`) and point links there; once the `ros-ai` command exists (roadmap item 5), `ros-ai mcp` takes over. Links made earlier keep working.

**How the server runs a command.** Binary candidates come from PATH and the known install places; `spawn` without a shell, a bounded time, inherited PATH and HOME only, as `codex-app-server.ts` already does. ros.ai never edits a settings file when the agent's CLI exists, keeps one backup before the first JSON merge, and records target, method, time and what was written in `links.json`. On Windows the `.cmd` shims need `cmd /c`, so file merges are preferred there.

**Apps through MCP servers with OAuth (slice 2).** The catalogue of hosted servers: Notion `https://mcp.notion.com/mcp`; Slack `https://mcp.slack.com/mcp`, reported generally available in February 2026 with per-user OAuth, whose rules require a Marketplace-listed or workspace-installed Slack app and admin approval, so ros.ai would need its own listed Slack app (Adam's call); GitHub `https://api.githubcopilot.com/mcp/` (OAuth; whether it accepts dynamic registration is unverified, so the fine-grained token stays as fallback); Linear `https://mcp.linear.app/mcp`; Atlassian `https://mcp.atlassian.com/v1/mcp`; Figma `https://mcp.figma.com/mcp`. The client is the `@modelcontextprotocol/sdk` streamable-HTTP client with its OAuth provider: discovery, PKCE, redirect to `http://localhost:4310/api/apps/callback`, a Client ID Metadata Document served from ros.ai cloud (the November 2025 authorization spec prefers it) with dynamic registration as fallback, tokens in owner-only files like `connections/google-drive.json`, refresh on the server. The tools then reach Ros's loop and External blocks under the project's approval mode: reads run, writes ask.

**Local, no sign-in.** Zotero's local API (`http://127.0.0.1:23119/api/`, after the person turns on "Allow other applications on this computer to communicate with Zotero" under Settings > Advanced) and synced folders (Drive, Dropbox, OneDrive), read like any project folder.

**Models.** Environment keys already count as configured; Ollama and LM Studio are registered as loopback connections with the models they list, at no USD; hosted Ros signs in through the existing device code. None of this grants spending: allowances stay a separate step, as today.

Sources found by search, not opened: [Notion's MCP guide](https://developers.notion.com/docs/get-started-with-mcp), [Cursor install links](https://cursor.com/docs/mcp/install-links), [Slack MCP server guide](https://gamut.so/blog/slack-mcp-server-guide), [the November 2025 authorization spec explained](https://den.dev/blog/mcp-november-authorization-spec/), [CIMD background](https://workos.com/blog/client-id-metadata-documents-cimd-oauth-client-registration-mcp), [Codex MCP configuration](https://learn.arm.com/learning-paths/servers-and-cloud-computing/performix-agentic-dynamic-insights-codex/configure_mcp_codex/).

## Architecture

Two new server modules and one screen. The MCP server, the credential files, the cloud sign-in and the Agents and Apps pages stay as they are.

| Piece | Where | What it does |
| --- | --- | --- |
| Detection | `src/server/detect.ts` (new) | `scan()`: PATH and known-path lookups, app bundles, dot-folders, modification times, loopback probes with a 300 ms timeout, MCP names from agent settings. Runs after `listen` and on `GET /api/setup`; cached; `ROS_NO_DETECT=1` skips it |
| Links | `src/server/links.ts` (new) | `link()` and `unlink()` per agent: CLI spawn or JSON merge; `links.json` in the data folder; `POST /api/setup/links` (batch) and `DELETE /api/setup/links/:id`; same local host, origin and JSON-only guards as the other private routes; not mounted in the public demo |
| Bridge in the data folder | `outside-agents.ts`, `publish()` | Also writes `<data>/bin/ros-ai-mcp.mjs`; links point there |
| Seen state | `outside-agents.ts` sessions | Already recorded per client label; the row reads it |
| First-run flag | `<data>/setup.json` | `{ seenAt }`; a "Show the setup screen again" switch in Settings |
| Types | `src/shared/setup.ts` | `DetectedTool`, `LinkRecord`, `SetupStatus` |
| Screen | `src/client/Setup.tsx`, rows shared with `ModelPage.tsx` and `PluginsPage.tsx` | `App.tsx` shows it before `RosStart` when `setup.json` has no `seenAt` and at least one row besides hosted Ros was found |
| Later: MCP client | `src/server/mcp-client.ts` | Hosted servers, OAuth, token files; tools into `AgentWorkspaceTools` and External blocks |

*Drawing in the doc (described):* three columns. Left, the browser page (the setup screen, then Agents and Apps), which talks only to the local server. Middle, the local server with detection, links, the MCP server at `/mcp` and the data folder (`links.json`, `setup.json`, `bin/ros-ai-mcp.mjs`). Right, the agents' own settings files, which each receive one `ros-ai` entry, and the agents themselves, which come back through the bridge to `/mcp`. Providers (Notion, Slack, GitHub) sit apart and are reached only in slice 2, through OAuth from the server.

The browser page talks only to the local server; the server writes one entry into each agent's own settings and keeps its records in the data folder; the agents come back through the bridge to `/mcp`; providers enter only in slice 2, through OAuth.

## Privacy and safety rules

The scan must stay something a careful person would be glad to see, which means it reads less than it could and says exactly what it did.

- **Local only.** Detection and linking never call ros.ai cloud or any other server; the only network traffic is loopback probes and, later, the OAuth flows the person starts. No telemetry, in line with the analytics recommendation of 18 October.
- **Read existence and names, never secrets.** Binaries, app bundles, folders, version strings, modification times and the names and hosts of MCP servers in agent settings. Never credential files, the keychain, `env` or `headers` values, shell start-up files, browser data or chat histories.
- **Write only on a click, only one entry.** Each link adds a single `ros-ai` entry; ros.ai keeps one backup before the first file merge and a record of what it wrote; Undo removes exactly that entry and nothing else.
- **Prefer the tool's own command.** Where an agent has `mcp add`, ros.ai uses it instead of editing the file, so the agent's own format and scope rules apply.
- **Bounded spawning.** Fixed binary candidates, no shell, inherited PATH and HOME only, a short timeout, as `codex-app-server.ts` does today.
- **Loopback MCP stays token-protected.** Links carry no token; the bridge reads the per-start token from the data folder, so another local user cannot reach the server.
- **OAuth tokens stay on the server.** Owner-only files, `state` and PKCE on every flow, redirect only to this local server, refresh on the server, never returned to the browser page, like `google-drive.ts`.
- **Apps obey the project's approval mode.** Reads run, writes ask, and External blocks stay read-only this round, as planned.
- **Agent logins are never copied.** Codex and Claude Code sign-ins stay inside those tools, the standing rule.
- **No spending is granted by connecting.** Keys, servers and sign-ins register a connection; allowances remain a separate, visible step.

## Phasing and effort

Slice 1 fits before the 24 October freeze because it adds a scan, a screen and settings entries; it touches no tool, block or prompt, which is what the freeze protects. Slices 2 and 3 wait for the submissions.

| Slice | What | Effort | When | Why then |
| --- | --- | --- | --- | --- |
| 1. Agents and models | Detect agents, models and Docker; the first-launch screen; silent links for Claude Code, Codex and Cursor (Gemini CLI and Claude Desktop if cheap); bridge in the data folder; *Seen* and Undo; the same rows on Agents; Ollama and LM Studio registered | About 2 days | Before 24 October, alongside the one Agents list | Gives the video its opening shot; additive; low risk |
| 2. Apps | MCP client with OAuth for Notion, GitHub, Linear and Figma; Slack once its app rules are settled; Zotero local API; synced folders as sources; apps usable by Ros and External blocks | About 4 to 5 days | After 30 October, unless the External block lands earlier and needs it | One mechanism replaces pasted tokens |
| 3. Packaging | `ros-ai` command, opt-in login-shell environment capture, Windows paths, rescan suggestions | About 2 days | With the install work (roadmap item 5) | Links survive updates and moves |

If time runs short, the minimum worth shipping is detection, the screen and the Claude Code and Codex links: about one day. Two checks need a Mac that has the apps: that the Codex app reads the shared `config.toml`, and the real first-call timing for the recording on 28 October.

## Open questions for Adam

- [ ] Scan automatically at first launch, with the one-line "what ros.ai looked at" (recommended), or ask first with a single *Look for my tools* button?
- [ ] Pre-tick found apps that need a browser OK (Notion, Slack), each waiting for one click after the silent links (recommended), or list them un-ticked with their own *Sign in*?
- [ ] Build slice 1 before the 24 October freeze (recommended, about two days), or after the submissions?
- [ ] Make MCP servers with OAuth the one mechanism for apps, with the client metadata document served from ros.ai cloud, and keep pasted tokens only as fallback?
- [ ] Slack's MCP server needs a listed ros.ai Slack app, which is an account change: create it later, or leave Slack on pasted tokens?
- [ ] Keep `ros-ai` as the entry name in every agent?
