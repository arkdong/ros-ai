# Eval: AISO Research recruitment, end to end

A repeatable real-use run of ros.ai on one real job: the AISO Research team's 2026/27 recruitment (2 roles, about 12 applicants), from applications to the final decision. Run it on the current build, without new features first. Each run shows where ros.ai breaks (bug), gives a wrong or weak result (not right), or makes the job slower than it should be (improve).

Set up 2026-10-19. Process source: AISO Notion, *Recruitment process 2026/27*, the Candidate Assessment and Interview Scoring Grid templates, and the Research team page.

## Rules for every run

- **Candidate data never enters this repository.** The snapshot, the ros.ai data folder, the project folder and the run logs all live in `~/ros-ai-evals/aiso-research/`. Only this protocol and anonymous findings come back to the repo or to GitHub issues.
- **Notion stays the system of record.** The eval reads a snapshot. Real decisions are still recorded in Notion by the people who own them; ros.ai output is a draft until someone copies it over.
- **Model for real data:** the choice from the 2026-10-19 decision (see *Model* under Setup). Do not switch to a hosted model mid-run.
- **Agents draft, people decide.** A run passes a stage only if a person reviewed what the agent proposed. Accepting without reading counts as a failed run.
- **Same snapshot, same steps.** Runs are comparable only on the same snapshot. Refresh it on purpose (new round, new applicants) and note the snapshot date in the run log.

## Setup (once per snapshot)

1. **Folder.**
   ```sh
   mkdir -p ~/ros-ai-evals/aiso-research/{snapshot,runs}
   ```
2. **Snapshot from Notion.** In the AISO Research recruitment page, open *Applications overview*, filter Teams contains Research (and Position contains Research, since some rows have no team), then **••• → Export → Markdown & CSV, include subpages and files**. Unzip into `snapshot/applicants/`. Export the role texts the same way from *Open positions for the team* into `snapshot/roles/`, and any Interviews pages with transcripts into `snapshot/interviews/`.
3. **CVs to text.** ros.ai reads `.md`, `.txt` and `.csv`, not PDF (known gap G2). Convert each CV next to its applicant file, for example `pdftotext -layout CV.pdf CV.txt` (`brew install poppler`), or paste the text into a `.md`.
4. **Model.** Configure it once on the Model page and give it an allowance on the Budget page.
   - Local: Model page → *Add a local model or server* → Ollama or LM Studio preset (`docs/inference-setup.md`).
   - Claude: Anthropic API key on the Model page; assistant set to Claude Code.
5. **Templates as notes.** Put `snapshot/templates/candidate-assessment.md` (Background, Motivation, Evidence, Strong points, Concerns, Current recommendation, Rationale) and `snapshot/templates/interview-grid.md` (relevant skills, demonstrated ability, motivation, personal/cultural fit, each 1-5 with evidence; overall Proceed / Reject) in the snapshot, copied from the Notion templates.

## Start a run

From an up-to-date checkout of the build under test (main, or a pull request through `npm run try`):

```sh
RUN=$(date +%F-%H%M)
mkdir -p ~/ros-ai-evals/aiso-research/runs/$RUN
cp -R ~/ros-ai-evals/aiso-research/snapshot ~/ros-ai-evals/aiso-research/runs/$RUN/project
ROS_DATA_DIR=~/ros-ai-evals/aiso-research/runs/$RUN/data npm start
```

A fresh data folder per run means each run starts from first launch. Open http://127.0.0.1:4310, configure the model (Setup 4), create a project named *AISO Research recruitment* and choose `runs/$RUN/project` as its folder. Copy the run log template (end of this file) to `runs/$RUN/log.md` and keep it open; note the time at the start of each stage.

## The stages

Each stage mirrors the AISO process. *Do* is what you ask ros.ai; *Check* is what must be true for a pass. Score each check Pass, Partial or Fail, and log every problem as it happens.

### 1. Intake

**Do.** Add the unplaced applicant, CV, role and template files to the canvas. Make one Group per role (Communications Associate, Operations Associate) and put each applicant's files in their role's Group. Load the applicants CSV as a dataset.

**Check.**
- 1a. Every applicant file and CV appears as unplaced and can be placed; none is missing or garbled.
- 1b. Applicants who applied to both roles are visible as such (expected gap G4 if not; note how you handled it).
- 1c. The CSV loads with the right number of rows and readable columns.
- 1d. Time to a usable canvas.

### 2. Screening (CV Screening, Initial score)

**Do.** For each applicant, select their files plus the role and the assessment template, and ask the assistant to draft a Candidate Assessment in the template's seven headings, quoting the applicant's own words as evidence. Review, edit, accept. Write your Initial score (1-5) at the top of the accepted note.

**Check.**
- 2a. The draft uses exactly the template's headings.
- 2b. Every claim traces to the application or CV; count invented or wrong facts.
- 2c. Quotes are word for word.
- 2d. It arrives as a proposal you review; accept, edit and Undo work.
- 2e. Contact details (email, phone, LinkedIn) are not repeated in the draft.
- 2f. Per applicant: minutes spent, and whether you accepted it unchanged, edited lightly, or rewrote it.
- 2g. Doing all applicants is practical (expected gap G3: no batch; note how many you did and how).

### 3. Interview 1 preparation

**Do.** For each applicant you would invite, ask for tailored Interview 1 questions from the accepted assessment and the role's *Key responsibilities* and *Good fit if*: claims to probe, gaps to explore, at most 8 questions.

**Check.**
- 3a. Questions refer to this applicant's actual claims, not generic ones.
- 3b. They cover all four grid criteria.
- 3c. You would use at least half of them as written.

### 4. Interview 1 record and first-round decision

**Do.** Where a transcript exists in the snapshot, add it and ask for a draft Interview Scoring Grid with evidence quoted from the transcript, then an update to the assessment. Score it yourself. Where no transcript exists yet, mark the stage *not reached* for that applicant.

**Check.**
- 4a. Each criterion's evidence is a real quote from the transcript.
- 4b. Draft scores differ from yours by at most 1 point per criterion (log each larger gap).
- 4c. The assessment update keeps earlier content and adds the interview findings.

### 5. Shortlist and comparison

**Do.** Put all scores (Initial, interview criteria, your recommendation) in a CSV in `data/`. In a Code or Notebook block, make a table per role and one figure: Initial score against interview score per applicant. Ask the assistant to compare the shortlist per role against the role text.

**Check.**
- 5a. The code runs in the sandbox and the figure is correct against the CSV (check two values by hand).
- 5b. The comparison only uses accepted notes and the CSV; no new facts.
- 5c. It states disagreements (high Initial, low interview, or the reverse) rather than averaging them away.

### 6. Final decision brief

**Do.** Ask for a one-page report per role for the Board: recommended offer(s), the evidence for each, open concerns, and who is not recommended and why. Export it as Markdown.

**Check.**
- 6a. Every statement links back to a note, transcript or figure.
- 6b. Recommendations match the decisions you made, not ones the model made up.
- 6c. The Markdown export opens and its evidence links work.
- 6d. You would send it to the Board after light edits.

### Across the whole run

- X1. No crash, frozen screen or lost work. Log any reload you needed.
- X2. Cost and turns from the Budget page at the end.
- X3. Total time, and time per stage.
- X4. Anything you had to do outside ros.ai (Notion, Finder, terminal), with why.

## Known gaps on 2026-10-19

Expected failures on the current build. Note them when you hit them, but they are not new findings; log only a new angle on them.

| ID | Gap | Where it shows |
| --- | --- | --- |
| G1 | Notion plugin only checks the token; it cannot read pages or databases | Setup 2 |
| G2 | No PDF reading | Setup 3 |
| G3 | No way to run one agent prompt per applicant in a batch | 2g |
| G4 | No record block with fields (status, scores); applicants are notes | 1b, 5 |
| G5 | No rules on the canvas (for example, no decision without an assessment) | all |

## Run log template

Copy to `~/ros-ai-evals/aiso-research/runs/<run>/log.md`.

```markdown
# Run <YYYY-MM-DD HH:MM>

Build: <main @ commit, or PR #>   Snapshot: <date>   Model: <name, local or hosted>
Applicants in snapshot: <n>   Reached stage 4: <n>   Reached stage 6: <yes/no>

## Scorecard

| Check | Result | Note |
| --- | --- | --- |
| 1a | Pass / Partial / Fail | |
| 1b | | |
| 1c | | |
| 1d | <minutes> | |
| 2a | | |
| 2b | <invented facts: n> | |
| 2c | | |
| 2d | | |
| 2e | | |
| 2f | <unchanged / light edit / rewrite counts; avg minutes> | |
| 2g | <applicants done of n> | |
| 3a | | |
| 3b | | |
| 3c | | |
| 4a | | |
| 4b | <gaps over 1 point: n> | |
| 4c | | |
| 5a | | |
| 5b | | |
| 5c | | |
| 6a | | |
| 6b | | |
| 6c | | |
| 6d | | |
| X1 | <crashes / reloads> | |
| X2 | <USD, turns> | |
| X3 | <total minutes> | |
| X4 | | |

## Findings

| # | Stage | Type | Severity | What happened | Expected | Steps to repeat |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2 | Bug / Not right / Improve | High / Medium / Low | | | |

Write findings without candidate names or details: "applicant 3's draft invented a second degree", not who they are.

## One-line verdict

<Would you run next round's screening in ros.ai? What would have to change first?>
```

## After a run

Paste the findings table (anonymous) into the ros.ai project thread, or ask for GitHub issues from it. Compare the scorecard with the previous run in `runs/`: the same check moving from Fail to Pass is the measure of progress.
