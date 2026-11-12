# Working in ros.ai

How the canvas, permissions, Python and agents work, in more detail than the [README](../README.md), which has the short version and the install.

## Start a project

**New project** is one card: the project's name on top, and below it the folder the project is saved in (suggested from the name until you change it) and **Start from**, which offers a blank map or a folder you already have. Enter creates the project. Before any project is open, the same card is the start screen.

- **Blank:** an empty map. **Add a block** in the middle of the map, or ask ROS in the bar.
- **A folder:** a folder ros.ai made opens with its canvas and history. Any other folder becomes a new project, and you choose which of its files to add.

A project's **… › Remove project** takes it off the list. Its folder stays where it is unless you also choose to move the folder to the Trash.

## The canvas

A block is named for how you work with it: Text, Code, Notebook, Data, File, Paper, Notion, Google Drive, Post, Metrics, Dashboard, Map, App, Agent, Web or Group. A Text block's label, the small pill beside its kind, says what it means to the project: a question, task, finding, decision, draft, or a word of your own. The arrow at the top right of a card, or a double-click, opens the block.

**Moving and picking.** Drag a block from anywhere on its card; it settles onto the grid when you let go. With the **Move** tool (V), dragging empty canvas draws a selection box. The blocks it touches, or blocks you Shift- or ⌘-click, drag, copy (⌘C, then ⌘V) and delete together. ⌘V also works in another project: the blocks arrive with their links and Groups, and their files are copied into that project's folder. With the **Hand** tool (H), dragging empty canvas moves the canvas. Hold Space to move the canvas from anywhere, or scroll with two fingers on a trackpad.

**Size.** Drag a card's bottom-right corner to resize it. Picked blocks can also be drawn **Small**, **Medium** or **Full**: the block stays whole and is drawn smaller.

**Groups.** Pick several blocks and choose **Group selected** in the dock. Only a Group contains blocks, and Groups can hold Groups. A block joins a Group when you drop it on the open Group and leaves when you drag it out. **Ungroup** removes the Group and leaves its blocks where they are. Surrounding blocks make room when a Group opens and close up again when it shuts.

**The dock** on the left edge names each tool on hover: **Up a level** returns to the surrounding group, **Tidy** lines blocks up, **See all** brings every block into view, **Collapse** closes every open group, **History** shows earlier versions of the map and **Share** saves the canvas as one file anyone can open.

**Links.** A link is one word between two blocks. Hover a block and drag one of the four dots on its border onto another block, or click a dot and then the block. The new link is selected with its word open: type a word and press Enter, pick a common one (supports, contradicts, answers, uses data from, builds on, part of), or press Esc to leave it unnamed. Click a line or its word to select it; click the word again, or press Enter, to change it, turn the link around or delete it. Backspace deletes a selected link, and Undo brings it back. Links from blocks inside a closed group meet at the group as one line with a count. ROS's own lines, from an Agent block to what it added or from a Web block to what it found, are trails: dotted, without a word. Links never run work or pass data along.

**History.** Undo and Redo cover adding, editing and deleting blocks and links. Moving, resizing and Tidy are saved but are not history steps, so they never discard a Redo. Saved outputs of a run are kept as versions; Undo never deletes them.

## Files and data

A project is a folder of plain files: Markdown for Text blocks, `.py` for Code, `.ipynb` for Notebooks, CSV for Data, and a `.canvas` file with the layout that Obsidian can draw. Edits saved in another app come back as changes you can undo. ros.ai's own records (history, conversations, saved outputs) are in its data folder, which the README names for each system. Stop the app before backing that folder up.

**Settings › Resources** lists what a project has captured: files, datasets and sources, with where each came from. A captured version does not change afterwards; using it in another block picks that exact version and does not run anything.

## Where ROS looks

Selecting a block changes nothing in the ROS bar. Each message quietly tells ROS where you are on the map: the open block, the blocks you clicked, the last few you looked at and the blocks on screen. ROS uses that only to tell what words like "this" or "these" point at, and works from your message across the whole map. A button on a block that asks ROS about it, such as **Check sources**, points ROS at that block on purpose.

## Permissions

Each project has one setting, in the ROS bar's menu and under **Permissions and usage**. New blocks follow it.

- **Ask every time:** every code run and every change to the canvas waits for you.
- **Approve for me:** plain data-analysis code (pandas, NumPy, SciPy, matplotlib and the standard maths modules) runs straight away, checked by fixed rules, not by a second model. Other imports and file or system access wait for you. Blocks an agent adds, moves, resizes or regroups land at once; it asks before it edits or removes anything already on the canvas, or opens a browser.
- **Full access:** code runs straight away in the sandbox and every canvas change lands without asking, edits and removals included. Every change stays undoable.

A write to an outside app such as Notion always asks, because Undo cannot take it back.

**Stop** in the bar (or Esc twice) stops ROS and the agent it is running. A Code or Notebook block that runs on its own has its own Stop. Closing the browser leaves the server working; quitting ros.ai stops running work, and reopening never repeats a paid request by itself.

## While an agent works

The ROS bar and the panel show what Claude Code or Codex is doing right now: thinking (with the thinking it shows, in its own words, or a count of what it keeps to itself), searching, writing, or preparing a change. A higher effort level means longer thinking between steps, not a silent screen.

A turn of Claude Code or Codex runs for up to 30 minutes. ros.ai tells the agent when half of that time is gone and when little is left, so its work reaches the map as it goes instead of all at the end, and in the last minutes it starts no new lookup. A turn that reaches the limit, or that you stop, keeps what it did: send "continue" and the agent carries on from there.

## Python

Code and Notebook blocks run ros.ai's own Python 3.12 with pandas, NumPy, matplotlib and SciPy. On a Mac it runs inside the macOS sandbox: it reads the project, writes its outputs, and reaches a website only after you allow it. On Linux and Windows it runs in Docker. [The Python sandbox](python-sandbox.md) has the exact boundary.

A Code block's program gets `params`, `pd`, `np`, `plt`, `scipy`, and helpers that save what it produces:

```python
metric("Mean", df["value"].mean())
table("Summary", df.describe().reset_index())
fig, ax = plt.subplots()
ax.plot(df["value"])
plot("Observations", fig)
export_csv("Data used", df)
```

`df` exists only when the block was given a CSV as its input.

## Your own agents

ros.ai is also an MCP server, so you can keep working in your own Claude Code, Codex, Cursor, Gemini CLI, Pi or Hermes Agent, signed in with your own plan or key. ros.ai never sees or handles that login.

At first launch ros.ai looks at this computer (the Applications folder, your PATH, the names in those agents' settings and the model servers on `127.0.0.1`; nothing is sent anywhere, and no credential file is opened) and shows one **Connect your tools** screen with what it found. **Connect** links them in one go: for Claude Code, Codex and Hermes Agent it runs their own `mcp add`, and for Cursor, Gemini CLI and Pi it adds one `ros-ai` entry to their settings file, with a one-time backup. Every link is one entry you can undo from the **Agents** page. Set `ROS_NO_DETECT=1` to skip the scan.

You can also paste the command yourself; the **Agents** page shows the exact path:

```sh
claude mcp add --scope user ros-ai -- node "/path/to/ros.ai data/bin/ros-ai-mcp.mjs"
codex mcp add ros-ai -- node "/path/to/ros.ai data/bin/ros-ai-mcp.mjs"
```

The agent can then read the canvas and your saved preferences and propose blocks, reports and analysis code. Proposals follow the project's permission setting, code runs only in ros.ai's sandbox, and the work appears in the ROS panel under the agent's name. Started inside a project's folder, the agent works in that project; otherwise it names one. ros.ai copies the bridge (`scripts/ros-ai-mcp.mjs`) into its data folder at every start and links point at that copy, so moving or updating the code keeps them working. The bridge talks to `127.0.0.1` with a token ros.ai writes to its data folder (`mcp.json`) at every start.

## ROS arranges the map

After any agent's turn, in ros.ai or from outside it, ROS gives what the agent left loose on the map a place: it groups and links those blocks, and puts an answer given only in chat on the map as blocks. That shows as one row, marked ROS, on the turn's card, follows the permission setting like the agent's own changes, and can be undone there. **Put this on the map** under an answer does it by hand. ROS runs on this computer once downloaded, or on hosted ROS while you are signed in, and otherwise ros.ai's own rules do it. Settings › General › ROS turns it off.

## Models and spending

The **Agents** page is where models and agents are connected, grouped by who pays. **Settings › Usage** shows what has been used, by model and by task, and **Settings › Balances** shows what each provider says is left. Paid calls are recorded, not capped; **Settings › General** holds an optional monthly budget.

More: [architecture](architecture.md) for the code.
