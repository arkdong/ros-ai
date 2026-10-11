# Dean demo runbook

How to run the two live cases for the UvA dean demo (week of 12 October 2026) with what ros.ai can do today. The slides are in `uva-dean-demo-slides.html`; these cases follow its last slide.

Each case starts from a prepared canvas that `npm run dean-demo` copies into a new project folder and opens in your running ros.ai. Everything after that happens live: the searches, findings and draft are real calls made during the demo.

## Before the meeting

1. Start ros.ai from your checkout with a larger Claude Code budget per turn. The research step searches, reads up to 15 pages and writes findings in one turn, which can go past the default of US$1:

   ```sh
   ROS_CLAUDE_TURN_USD=3 npm start
   ```

2. Check the connections once: an Anthropic key on **Model**, a Tavily key on **Plugins**, and allowances for both under **Budget**.
3. Set up the case in a second terminal:

   ```sh
   npm run dean-demo -- abn-amro-drafting
   ```

   Reload the page and open **ABN AMRO · drafting an Insights article** from the project list. Running the command again makes a fresh copy, numbered (2), (3) and so on.
4. Do one full rehearsal the evening before and keep that project. If the network or a key fails during the meeting, open the rehearsed project instead and walk through it. **Try demo mode** also opens the recorded case *AI adoption in Dutch businesses · the banking question*, which makes no calls at all.
5. In the meeting, keep the permission button in the header on **Ask every time**, so every plan and every draft visibly waits for you.

## Case 1 · ABN AMRO: drafting an Insights article

**The story.** AURORA, built by AISO with ABN AMRO, drafts Insights articles through fixed stages: approved sources, citations, audit trail, quality checks and human sign-off. The same lessons apply to research, but a researcher needs to explore rather than follow a fixed pipeline. Here ros.ai drafts the same kind of article on one canvas, where every claim can be traced back to the sentence it came from.

**On the canvas at the start**
- **Brief**: the question, the reader, the evidence rules and what is out of scope.
- **Writing guide**: a summary of the ABN AMRO house style as AURORA applied it.
- **Review checklist**: the AURORA-style checks you go through before accepting the draft.

### Step 1 · Research (about 3–5 minutes, roughly US$0.50–1.20)

Click the **Brief**, open **Assistant**, pick **Claude Code** in the model list and send:

> Research this brief for the article. Plan five search directions that mix Dutch and English sources, such as CBS, KVK, De Nederlandsche Bank, the European Commission and ABN AMRO Insights. Then read the most useful pages, save the claims that matter as Finding notes that quote each page word for word, and propose theme groups, setting weak or off-topic results aside.

1. A plan card appears with the directions, the number of searches and the cost. Approve it. *Talking point: nothing searches the web until the researcher says yes.*
2. The Agent block appears next to the Brief. Each direction grows a Search block and a Result note with a cited summary. The sentence the agent writes before each step shows on its card.
3. Finding notes appear, each quoting its page word for word. ros.ai refuses a quote it cannot find on the saved page.
4. A grouping card proposes themes plus a folded **Set aside** group. Approve it. *Talking point: weak sources are kept and labelled, not deleted.*

### Step 2 · Draft (about 1–2 minutes)

Choose **Add block → Report**, name it *Draft article* and add it. With the Report block selected, send:

> Draft the article into this Report block, following the Brief and the Writing guide. Do not search again: use only the Finding notes in the project folder as evidence, link each source where it is used, and end with a short paragraph on what the evidence does not show.

A **Review report revision** card appears. Open it and go through the **Review checklist** out loud before you press **Accept report revision**. *Talking point: this is AURORA's human sign-off. Accepting saves a new report version; nothing is published.*

### Step 3 · Show the trail (as long as the questions last)

- **Supporting evidence:** open a Finding to show the quote and the page it came from.
- **History:** double-click the Agent block to show its timeline: every search, page read and proposal, in order.
- **Limits:** open the **Set aside** group and the draft's closing paragraph.
- **Control:** undo a change and redo it; show the project folder in Finder, where every block is a Markdown file; the keys and the budget stay on this computer.
- **Hand-in:** open the report and download the **Self-contained HTML**. It includes the AI-use statement and the record of how the report was produced.

## Case 2 · AISO

To be added once the case is chosen.
