// Kept free of CodeMirror imports so blocks can use it without loading the editor bundle.

/** What the editor knows about the program's runtime. Everything here is static and local. */
export interface CodeContext {
  /** Docker Python (pandas, NumPy, matplotlib, SciPy), the Nebius standard-library worker, or the legacy bounded interpreter. */
  runtime: 'docker' | 'stdlib' | 'bounded';
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

/** Helpers shown as insert chips under the editor. */
export const helperInserts = (runtime: CodeContext['runtime']) => ({
  docker: ['metric("Name", value)', 'table("Title", df)', 'plot("Title", fig)', 'export_csv("Title", df)', 'conclusion("Text")'],
  stdlib: ['metric("Name", value)', 'table("Title", rows)', 'plot("Title", values)', 'export_csv("Title", rows)', 'conclusion("Text")'],
  bounded: ['column("name")', 'metric("Name", value)', 'table("Title", describe(values))', 'plot("Title", values)'],
})[runtime];
