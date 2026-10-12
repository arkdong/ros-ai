# AURORA visuals for the UvA lessons slide

## Current slide: supplied architecture diagram

`aurora-architecture.png` is the original 1920 × 1080 image supplied by Adam
as `/Users/adamdong/Downloads/aurora.png`. It is copied byte-for-byte and
embedded in the HTML deck for offline presentation. The same architecture
appears on page 13 of the existing AURORA presentation.

Five arrow-controlled views keep the diagram fixed: overview, supporting
evidence, history, limitations, and researcher control. SVG overlays dim
unselected areas and outline the relevant regions. The image itself is
unchanged, with no cropping or rewritten labels. Highlight coordinates use
the image's original 1920 × 1080 coordinate system, so they scale together
with the diagram. Speaker cues are recorded in `draft_marc_demo.md` and in
the HTML presentation's notes.

The diagram illustrates an architecture, not a recorded experiment or a
live application state. Human-signoff flags indicate review requirements;
the proof of concept does not complete or enforce human approval. Its audit
store label does not establish durable production storage. Local working,
privacy, reproducibility and control over external connections are broader
research requirements, not guarantees established by the diagram.

## Previous slide version: excerpts retained as source assets

Source: `/Users/adamdong/code/AURORA/deliverables/AURORA_presentation.pdf`,
the existing ABN AMRO × AISO project presentation dated 22 June 2026.
These are excerpts of its diagrams, not screenshots of a running application.
The original wording and visual styling are retained.

| Asset | PDF page (one-based) | Excerpt |
| --- | --- | --- |
| `aurora-source-evidence.png` | 17 | Three context-pack entries with source, node ID and reason |
| `aurora-output-draft.png` | 20 | Grounded Draft output card |
| `aurora-output-citations.png` | 20 | Citations output card |
| `aurora-output-checks.png` | 20 | KPI Score output card |
| `aurora-output-audit.png` | 20 | Audit Trace output card |
| `aurora-review-limits.png` | 21 | Blocked-with-reasons and pending-human-sign-off states |

The previous slide version laid out the four output cards in a two-by-two grid.
The evaluation excerpt selects two of the original three illustrated states;
it does not imply these states occur together on a particular run.
These six PNGs are retained locally but are no longer embedded in slide 7.

## Extraction

Rendered locally with Poppler `pdftoppm`, at a 4200-pixel page width.
Crop coordinates below refer to the inspected 1400-pixel page render and
were multiplied by three for the final rendering:

| Asset suffix | Page | x | y | width | height |
| --- | ---: | ---: | ---: | ---: | ---: |
| source-evidence | 17 | 1083 | 430 | 250 | 185 |
| output-draft | 20 | 1223 | 340 | 98 | 51 |
| output-citations | 20 | 1223 | 400 | 98 | 50 |
| output-checks | 20 | 1223 | 460 | 98 | 50 |
| output-audit | 20 | 1223 | 521 | 98 | 50 |
| review-limits | 21 | 1075 | 425 | 205 | 207 |

## Interpretation

The lessons are supported by `deliverables/AURORA_Final_Report.md`,
particularly its evaluation, data-handling and interface sections:
source references accompany retrieved material; stage inputs and outputs
contribute to an audit trail; evaluation surfaces findings and pending human
review requirements. The proof of concept does not complete or enforce the
human sign-off depicted in the evaluation diagram.

Reproducibility, local working, privacy and control over external connections
are broader considerations for the proposed research environment. They are
not presented as demonstrated AURORA guarantees. No live model or external
API calls were made to prepare this slide.
