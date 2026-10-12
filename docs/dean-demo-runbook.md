# Dean demo runbook

How to show ros.ai to the dean of UvA's Faculty of Economics and Business (week of 12 October 2026). The slides are in `uva-dean-demo-slides.html`; this demo follows its last slide.

The demo is a guided walk-through in demo mode: **Try demo mode → From idea to report · AI in Dutch business**. It takes one question, how AI is changing Dutch businesses and what that means for a bank such as ABN AMRO, from a first idea to a report in seven steps. Each **Next** adds one step's blocks to the canvas and shows them together, so the canvas grows from one note to the whole piece of research. It works with no keys and no network, and every block stays live and editable.

## Before the meeting

1. Start Docker Desktop, then ros.ai. ros.ai checks for the Python sandbox only when it starts. The sandbox image is built once with `docker build -t ros-ai-research-python:1 src/server/sandbox`.
2. Click **Try demo mode**, keep **From idea to report** selected and press **Start demo**. ros.ai creates a new project folder (`~/Documents/ros.ai/Demo · AI in Dutch business`, numbered when that folder already exists) and opens it with the demo guide. The assistant and the sidebar start closed to give the canvas room; **Assistant** and the sidebar button bring them back. Every start makes a fresh project, so rehearse on one and start a clean one for the meeting.
3. Keep the permission button in the header on **Ask every time**, so every run visibly waits for you.
4. For the optional live search, put an Anthropic key on **Model** and a Tavily key on **Plugins**, and set allowances for both under **Budget**.

## The seven steps

The guide sits at the lower left. Its main button names the next step; the numbered steps at the top go back to an earlier view; an **Open** button opens a block and folds the guide away, and the arrow on the folded guide brings it back.

1. **Idea.** One note with the question. *Talking point: a project starts as a rough question, not a finished plan.*
2. **Search.** A Claude Code agent takes the idea on: six directions, eight web searches and 27 sources, with a Result note per direction that cites its pages. Open the agent to show its plan. *Talking point: in a live run nothing searches the web until the researcher approves the plan.*
3. **Read.** The agent reads the eleven best pages in full and saves twelve Findings, each quoting its page word for word. Open a finding. *Talking point: every claim can be traced back to the sentence it came from, and ros.ai checks each quote against the saved page.*
4. **Group.** The findings fall into three themes, two weak ones go to **Set aside** instead of being deleted, and the themes support one **Leading conclusion**: AI use rises with company size, and readiness lags behind.
5. **Test.** CBS's own table and a Code block that checks the data and calculates the 41.4-point gap between the smallest and the largest firms. Open the code, press **Run**, review the captured attempt and press **Allow & run**: it calculates again in the sandbox on this computer in a few seconds. *Talking point: someone without Python can ask for this in plain words; the code, data and every attempt are kept.*
6. **Charts.** A notebook and three figures. Open the notebook and press **Run all**, then approve: the cells run again and the chart redraws.
7. **Report.** The final article, with every source and figure linked to the saved page or result. Open it and download the **Self-contained HTML** to show the hand-in with its AI-use statement.

**Finish demo** closes the guide and **Tutorial** in the canvas header opens it again. **See all** in the left dock shows the whole canvas. To finish, show control: undo and redo a change, and show the project folder in Finder, where every block is a plain file.

## Optional: a live search

Close the guide, click **The idea**, open **Assistant**, pick **Claude Code** under Agents and ask, for example: *Research how AI is changing Dutch small businesses in three directions, mixing Dutch and English sources such as CBS, KVK and ABN AMRO Insights, and save the claims that matter as findings.* Approve the plan card. A second Agent block grows with real Tavily results. This costs roughly US$0.50–1.20; start ros.ai with `ROS_CLAUDE_TURN_USD=3 npm start` if the turn needs more than the default US$1.

## What is recorded and what is live

- The web searches and the pages were captured on 11 October 2026 while the demo was prepared, apart from one CBS chapter captured on 23 September 2026. They are labelled as such: the agent shows **A recorded run**, and each saved page and search result carries **Recorded for this demo**. Every finding's quote is checked word for word against its saved page when the demo starts.
- The grouping, the conclusion and the report were written while the demo was prepared, from those findings and calculations. The report says so in its AI-use statement.
- The Code block's results are saved from an earlier sandbox run of the same code, and the notebook's outputs come from a real run of its cells in ros.ai's sandbox. **Run** calculates them again for real.
- **Next** makes no model, search or code calls. Only the optional live search calls Claude and Tavily.
