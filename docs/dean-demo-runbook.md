# Dean demo runbook

How to show ros.ai to the dean of UvA's Faculty of Economics and Business (week of 12 October 2026). The slides are in `uva-dean-demo-slides.html`; this demo follows its last slide.

The demo is one canvas in demo mode: **Try demo mode → The whole workspace · AI use by company size**. It holds every kind of block, from a Claude Code agent with its Tavily searches to a draft article, so it works with no keys and no network. Everything on it stays live: you can run the code and the notebook again, and start a real search from the question.

## Before the meeting

1. Start Docker Desktop, then ros.ai. ros.ai checks for the Python sandbox only when it starts. The sandbox image is built once with `docker build -t ros-ai-research-python:1 src/server/sandbox`.
2. For the live search, put an Anthropic key on **Model** and a Tavily key on **Plugins**, and set allowances for both under **Budget**. Without them, show the recorded search and skip step 6.
3. Click **Try demo mode**, keep **The whole workspace** selected and press **Start demo**. ros.ai copies the canvas into a new project folder (`~/Documents/ros.ai/ros.ai demo · AI use by company size`) and opens it. Every start makes a fresh copy, so rehearse on one and start a clean one for the meeting.
4. Keep the permission button in the header on **Ask every time**, so every run visibly waits for you.

## The walk-through

The canvas reads from left to right. **See all** in the left dock shows the whole of it.

1. **Start here and Question.** The question is the ABN AMRO one: how AI use differs between small and large Dutch businesses, and what a bank should ask its business clients about it.
2. **Agent.** Double-click the Agent block. Claude Code took the question on, planned three search directions and waited for approval before searching. *Talking point: nothing searches the web until the researcher says yes.* This run is recorded and says so on the block.
3. **Search and Result.** Each Search block is one Tavily search. The Result note next to it summarises what came back and lists the pages it cites.
4. **Findings.** Each Finding quotes its page word for word, here the CBS AI monitor. *Talking point: every claim can be traced back to the sentence it came from.*
5. **Data, Code and Notebook.** Double-click **AI use by company size**. The saved results from an earlier run are on the right. Press **Run**, review the captured attempt and press **Allow & run**: the code runs in the sandbox on this computer and the figures appear again in a few seconds (a 41.4-point gap in AI use between the smallest and largest firms). Then open **Explore the turnover gap**, the notebook, and run a cell. *Talking point: someone without Python can ask for this in plain words; the code, data and every attempt are kept.*
6. **Live search (optional).** Click the **Question**, open **Assistant**, pick **Claude Code** and ask, for example: *Research this question in three directions, mixing Dutch and English sources such as CBS, KVK and ABN AMRO Insights, and save the claims that matter as findings.* Approve the plan card. A second Agent block grows next to the recorded one with real Tavily results. This costs roughly US$0.50–1.20; start ros.ai with `ROS_CLAUDE_TURN_USD=3 npm start` if the turn needs more than the default US$1.
7. **Draft article.** Open the report: the article is built from the findings and the calculated figures and ends with what the evidence does not show. Download the **Self-contained HTML** to show the hand-in, with its AI-use statement.
8. **Control.** Undo and redo a change; show the project folder in Finder, where every block is a plain file; the keys and the budget stay on this computer.

## What is recorded and what is live

- The searches, Result notes, findings and the draft were prepared for this demo from pages and data captured on 23 September 2026 (CBS AI monitor 2024 and two ABN AMRO Insights articles). They are labelled as recorded on the canvas.
- The saved Code results come from the Docker run of the same code on 23 September 2026. Pressing **Run** calculates them again for real.
- The notebook's outputs come from a real run of its cells in ros.ai's sandbox. Running a cell again recalculates it.
- Only step 6 calls Claude and Tavily.
