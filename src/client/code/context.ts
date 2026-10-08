// Kept free of CodeMirror imports so blocks can use it without loading the editor bundle.

/** What the editor knows about the program's runtime. Everything here is static and local. */
export interface CodeContext {
  /** Docker Python (pandas, NumPy, matplotlib, SciPy), a notebook's Python (the same libraries, no ros.ai helpers),
   * the Nebius standard-library worker, or the legacy bounded interpreter. */
  runtime: 'docker' | 'notebook' | 'stdlib' | 'bounded';
  /** Column names of the selected CSV; in Docker Python `df` exists only when one is selected. */
  columns: string[] | null;
  /** Keys of the current parameters JSON object. */
  paramKeys: string[];
}

/** Short starting programs for an empty Code block. */
export function starters(context: CodeContext): { label: string; code: string }[] {
  const column = context.columns?.[1] ?? context.columns?.[0] ?? 'value';
  const list = [{ label: 'Hello metric', code: 'values = [3, 4, 5]\nprint("Sum:", sum(values))\nmetric("Sum", sum(values))\n' }];
  if (context.columns) list.push(
    { label: 'Summarize CSV', code: 'print(df.shape)\ntable("Summary", df.describe(include="all").reset_index())\nmetric("Rows", len(df))\n' },
    { label: 'Plot a column', code: `fig, ax = plt.subplots()\nax.plot(df[${JSON.stringify(column)}])\nax.set_title(${JSON.stringify(column)})\nplot(${JSON.stringify(`${column} over rows`)}, fig)\n` },
  );
  list.push({ label: 'Use parameters', code: 'n = int(params.get("n", 10))\nsquares = pd.DataFrame({"x": range(n), "square": [x * x for x in range(n)]})\ntable("Squares", squares)\nexport_csv("Squares CSV", squares)\n' });
  return list;
}

/** ros.ai's output helpers, shown as insert chips under the Code editor with a short guide on hover. */
export const outputHelpers: { name: string; insert: string; what: string; shows: string; example: string }[] = [
  { name: 'metric', insert: 'metric("Name", value)', what: 'Saves one named number or short value.', shows: 'A large number on the card and in Results.', example: 'metric("Mean price", df["price"].mean())' },
  { name: 'table', insert: 'table("Title", df)', what: 'Saves a DataFrame, Series or list of rows as a table (up to 10,000 rows).', shows: 'A table you can sort and inspect.', example: 'table("Summary", df.describe())' },
  { name: 'plot', insert: 'plot("Title", fig)', what: 'Saves a matplotlib figure as an image. Leave out fig to save the current one.', shows: 'A figure on the card and in Results.', example: 'fig, ax = plt.subplots()\nax.hist(df["price"])\nplot("Price spread", fig)' },
  { name: 'export_csv', insert: 'export_csv("Title", df)', what: 'Saves a DataFrame as a new CSV dataset.', shows: 'A dataset another block can use as its Data input.', example: 'export_csv("Clean prices", df.dropna())' },
  { name: 'conclusion', insert: 'conclusion("Text")', what: 'Saves a short written takeaway from this run.', shows: 'Text in Results, ready for a report.', example: 'conclusion("Prices rose 4% after 2020.")' },
];

/** Parameter keys the program reads, as `params["key"]` or `params.get("key", default)`, with any literal default. */
export function paramsRead(source: string): { key: string; fallback?: unknown }[] {
  const found = new Map<string, unknown>();
  for (const match of source.matchAll(/params\s*(?:\[\s*(["'])([^"'\]]+)\1\s*\]|\.get\(\s*(["'])([^"']+)\3\s*(?:,\s*([^)]+?))?\s*\))/gu)) {
    const key = match[2] ?? match[4];
    if (found.has(key) && found.get(key) !== undefined) continue;
    let fallback: unknown;
    try { if (match[5]) fallback = JSON.parse(match[5].replace(/^'(.*)'$/u, '"$1"').replace(/^True$/u, 'true').replace(/^False$/u, 'false').replace(/^None$/u, 'null')); } catch { /* Not a literal: no default to offer. */ }
    found.set(key, fallback);
  }
  return [...found].map(([key, fallback]) => ({ key, ...(fallback === undefined ? {} : { fallback }) }));
}
