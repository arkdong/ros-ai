# Datasets, figures and reports

Implemented locally September 30, 2026. These viewers operate on retained records and make no inference, search or analysis execution calls. Current whole-workspace verification belongs in `RESULT.md`.

## Inspect and derive data

Resources opens a CSV as a table rather than a truncated text preview. Dataset/table artifacts use the same viewer. Page through every retained row, search all cells, filter one column by contained text, click a header to sort, select 10/25/50/100 rows per page, and choose visible columns. Summaries report rows, columns, inferred types and empty-cell counts. Empty means blank after trimming; strings such as `NA` are not silently treated as missing. Types are viewing hints and never coerce the original values. The full captured CSV downloads directly. Artifact/resource view preferences remain in browser storage, outside canvas content history.

**Add dataset block to canvas** makes a captured resource directly visible on the board. **Save a cleaned / derived copy** can trim whitespace, drop entirely empty rows, remove exact duplicates, drop rows missing a selected column, and explicitly include the current search/filter/sort. Before/after row and missing-cell counts and row viewers precede saving. The fixed operations create a new dataset block with an exact source artifact/hash and the transformation recorded. There is no Python execution or original-file write. A linked file must still match the preview hash when captured; stale sources are rejected. CSV import and derivation keep the 500,000-byte limit. Unsupported/malformed tables retain an accessible raw capture.

## Read and refine figures

Saved SVG figures open at a readable size, support 50–400% zoom and direct SVG download, and show the producing attempt, exact captured input artifacts and saved provenance. A caption/title/report-width refinement creates a new artifact identity with the original SVG unchanged. Its derivation records the original artifact ID/hash. Existing report evidence never switches to that newer identity automatically.

When generating code is retained, **Prepare code refinement for review** opens a separate Action draft containing that code and captured data. Recomputing requires the normal exact experiment preview, approval, isolation and cumulative resource admission. No arbitrary old SVG is claimed to be an editable chart specification; no raw observations are reconstructed from an image.

## Write ordinary project reports

**New report** works in an ordinary project. Use Markdown prose, headings, lists and pipe tables, or insert an exact saved figure/table/evidence artifact at the text cursor. Captions appear with their figure where inserted. `![Caption](artifact:ID)` inserts a saved figure or table; `[Support](artifact:ID)` links evidence. Supporting captures must be explicitly selected. Write/Preview displays the draft, and local browser drafts survive evidence inspection.

**Save report version** creates an immutable Markdown artifact and an undoable report-block pointer change. A subsequent revision retains the previous artifact and its exact evidence manifest. Viewing a report opens the original captured evidence and provenance, with a return control. A newer-version warning does not replace the selection. User interpretation, source claims, measured artifacts and recorded model claims have separate labels. Accepted Codex report proposals use an explicit provenance option on the store service; that option records origin and does not grant approval. The agent-tool decision boundary must separately enforce authorization.

Download **Markdown + evidence** or **Self-contained HTML**. Both retain selected captured contents, versions and provenance. HTML embeds saved SVGs as images, includes full inline tables/evidence and uses a restrictive no-script/no-network content policy. Markdown embeds SVG data URLs and inline tables; some external Markdown readers may choose not to render data-URL images. HTML is the more portable standalone reading surface. No PDF, DOCX or arbitrary chart editor is implemented.

The two archived banking-article figure filenames have a deliberate compatibility mapping to the article's uniquely selected saved plots. General reports use exact artifact IDs. Unknown image paths remain visibly unavailable until the author selects a captured figure; the app does not guess data from filenames or load external images.

## Verification scope

A disposable direct Store/service check exercised 82 captured rows, later-row access/filtering, a 79-row cleaned copy, preservation of originals, stale-hash rejection, a separate caption-derived figure, ordinary report creation, exact inline figure placement, complete exported tables/evidence, and revision undo that restores the prior artifact pointer while preserving immutable additions. This check used local fixture records and no model/Python execution. The integrated browser smoke and build are recorded by the owning workspace task.
