import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import { snippetCompletion } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { CodeContext } from './context';

type Helper = { label: string; detail: string; info: string; type?: string };
const dockerHelpers: Helper[] = [
  { label: 'metric', detail: '(title, value)', info: 'Save one named number or value as a metric output.' },
  { label: 'table', detail: '(title, data)', info: 'Save a DataFrame, Series or list of records as a table (up to 10,000 rows × 100 columns).' },
  { label: 'plot', detail: '(title, figure=None)', info: 'Save a matplotlib figure as SVG. Uses the current figure when none is given.' },
  { label: 'export_csv', detail: '(title, frame)', info: 'Save a DataFrame (or data convertible to one) as a CSV dataset output.' },
  { label: 'conclusion', detail: '(text)', info: 'Save a short written conclusion for this attempt.' },
  { label: 'params', detail: 'dict', info: 'The JSON parameters saved with this block.', type: 'variable' },
  { label: 'pd', detail: 'pandas', info: 'pandas 2.2', type: 'namespace' },
  { label: 'np', detail: 'numpy', info: 'NumPy 2.2', type: 'namespace' },
  { label: 'plt', detail: 'matplotlib.pyplot', info: 'matplotlib 3.10 (Agg backend)', type: 'namespace' },
  { label: 'scipy', detail: 'scipy', info: 'SciPy 1.15', type: 'namespace' },
];
const stdlibHelpers: Helper[] = [
  { label: 'metric', detail: '(title, value)', info: 'Save one named value as a metric output.' },
  { label: 'table', detail: '(title, records)', info: 'Save a list of dictionaries as a table.' },
  { label: 'plot', detail: '(title, values, labels=None)', info: 'Save a simple SVG chart of numeric values.' },
  { label: 'export_csv', detail: '(title, records)', info: 'Save a list of dictionaries as a CSV dataset output.' },
  { label: 'conclusion', detail: '(text)', info: 'Save a short written conclusion for this attempt.' },
  { label: 'rows', detail: 'list[dict]', info: 'The captured CSV as a list of dictionaries with string values.', type: 'variable' },
  { label: 'columns', detail: 'list[str]', info: 'The captured CSV column names.', type: 'variable' },
  { label: 'params', detail: 'dict', info: 'The JSON parameters saved with this attempt.', type: 'variable' },
];
const boundedHelpers: Helper[] = [
  { label: 'column', detail: '(name)', info: 'Numeric values of one CSV column as a list.' },
  { label: 'columns', detail: '()', info: 'The CSV column names.' },
  { label: 'describe', detail: '(values)', info: 'Count, mean, median, min, max and stdev as table rows.' },
  { label: 'linear_fit', detail: '(x, y)', info: 'Slope and intercept of a least-squares line.' },
  { label: 'mean', detail: '(values)', info: 'statistics.mean' },
  { label: 'median', detail: '(values)', info: 'statistics.median' },
  { label: 'stdev', detail: '(values)', info: 'statistics.stdev' },
  { label: 'variance', detail: '(values)', info: 'statistics.variance' },
  { label: 'metric', detail: '(title, value)', info: 'Save one named value as a metric output.' },
  { label: 'table', detail: '(title, rows)', info: 'Save a list of values or dictionaries as a table.' },
  { label: 'plot', detail: '(title, values, labels=None)', info: 'Save a simple SVG chart of numeric values.' },
  { label: 'params', detail: 'dict', info: 'The JSON parameters saved with this attempt.', type: 'variable' },
];
// Notebook cells import libraries themselves, as in Jupyter; display() is the one name provided.
const notebookHelpers: Helper[] = [
  { label: 'display', detail: '(value)', info: 'Show a value, table or figure below the cell, as in Jupyter.' },
];
const runtimeHelpers = { docker: dockerHelpers, notebook: notebookHelpers, stdlib: stdlibHelpers, bounded: boundedHelpers };

const members: Record<string, string[]> = {
  pd: ['DataFrame', 'Series', 'read_csv', 'concat', 'merge', 'to_datetime', 'to_numeric', 'date_range', 'Timestamp', 'Timedelta', 'cut', 'qcut', 'crosstab', 'pivot_table', 'get_dummies', 'isna', 'notna', 'unique', 'value_counts', 'melt', 'NA'],
  np: ['array', 'arange', 'linspace', 'zeros', 'ones', 'full', 'mean', 'median', 'std', 'var', 'sum', 'min', 'max', 'percentile', 'quantile', 'sqrt', 'log', 'log10', 'exp', 'abs', 'round', 'where', 'nan', 'isnan', 'nanmean', 'nanmedian', 'nanstd', 'corrcoef', 'cumsum', 'diff', 'clip', 'sort', 'argsort', 'unique', 'histogram', 'polyfit', 'random', 'pi', 'inf'],
  'np.random': ['default_rng', 'seed', 'normal', 'uniform', 'choice', 'integers', 'random'],
  plt: ['subplots', 'figure', 'plot', 'scatter', 'bar', 'barh', 'hist', 'boxplot', 'title', 'xlabel', 'ylabel', 'legend', 'grid', 'xticks', 'yticks', 'xlim', 'ylim', 'tight_layout', 'axhline', 'axvline', 'fill_between', 'gcf', 'gca', 'close'],
  ax: ['plot', 'scatter', 'bar', 'barh', 'hist', 'boxplot', 'set_title', 'set_xlabel', 'set_ylabel', 'set_xlim', 'set_ylim', 'legend', 'grid', 'axhline', 'axvline', 'fill_between', 'annotate', 'text', 'tick_params', 'twinx'],
  fig: ['suptitle', 'tight_layout', 'set_size_inches', 'add_subplot', 'colorbar'],
  scipy: ['stats', 'optimize', 'interpolate', 'signal', 'integrate', 'linalg'],
  'scipy.stats': ['ttest_ind', 'ttest_rel', 'ttest_1samp', 'mannwhitneyu', 'wilcoxon', 'pearsonr', 'spearmanr', 'kendalltau', 'linregress', 'chi2_contingency', 'f_oneway', 'kruskal', 'shapiro', 'normaltest', 'describe', 'zscore', 'sem', 'norm', 't', 'chi2', 'bootstrap'],
  df: ['head', 'tail', 'describe', 'info', 'shape', 'columns', 'dtypes', 'groupby', 'agg', 'sort_values', 'sort_index', 'value_counts', 'mean', 'median', 'sum', 'count', 'min', 'max', 'std', 'corr', 'isna', 'dropna', 'fillna', 'drop', 'drop_duplicates', 'rename', 'assign', 'query', 'loc', 'iloc', 'merge', 'pivot_table', 'melt', 'apply', 'astype', 'copy', 'reset_index', 'set_index', 'nunique', 'unique', 'quantile', 'resample', 'rolling', 'plot', 'to_csv'],
  params: ['get', 'keys', 'items', 'values'],
  rows: ['append', 'count', 'index', 'sort'],
};

const figureSnippet = snippetCompletion('fig, ax = plt.subplots()\nax.${}\nplot("${Figure title}", fig)', { label: 'figure', detail: 'new matplotlib figure', type: 'text' });
const csvSnippets: Completion[] = [
  snippetCompletion('table("${Summary}", df.describe().reset_index())', { label: 'summary', detail: 'describe the CSV as a table', type: 'text' }),
  snippetCompletion('table("${Grouped}", df.groupby("${column}")["${value}"].agg(["count", "mean"]).reset_index())', { label: 'groupby', detail: 'grouped summary table', type: 'text' }),
];

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Columns with these names are not reachable as df.name, so they are only offered inside df["…"].
const notAttributes = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
  ...members.df, 'T', 'at', 'axes', 'empty', 'iat', 'index', 'ndim', 'size', 'str', 'style', 'values',
]);
const notebookSnippets: Completion[] = [
  ...[['pandas', 'pd'], ['numpy', 'np'], ['matplotlib.pyplot', 'plt']].map(([module, name]) => snippetCompletion(`import ${module} as ${name}`, { label: `import ${module} as ${name}`, type: 'text' })),
  snippetCompletion('fig, ax = plt.subplots()\nax.${}', { label: 'figure', detail: 'new matplotlib figure', type: 'text' }),
];
const snippets = (context: CodeContext) => context.runtime === 'notebook' ? notebookSnippets : context.runtime !== 'docker' ? [] : context.columns ? [figureSnippet, ...csvSnippets] : [figureSnippet];
const helpers = (context: CodeContext) => runtimeHelpers[context.runtime]
  .map<Completion>(helper => ({ label: helper.label, detail: helper.detail, info: helper.info, type: helper.type ?? 'function', boost: 2 }))
  .concat(context.runtime === 'docker' && context.columns ? [{ label: 'df', detail: 'DataFrame', info: `The selected CSV · ${context.columns.length} columns`, type: 'variable', boost: 2 }] : []);

/** ros.ai helpers, library members, CSV columns and parameter keys. Python's own keywords,
 * builtins and local names come from @codemirror/lang-python and are merged by the editor. */
export function rosCompletionSource(read: () => CodeContext): CompletionSource {
  return (completion: CompletionContext): CompletionResult | null => {
    const context = read();
    // df["col  /  row["col  /  column("col  /  params['key
    const subscript = completion.matchBefore(/\b(?:(df|row|params)\[|(column)\()\s*["'][^"'\])]*$/);
    if (subscript) {
      const quote = subscript.text.search(/["']/);
      const isParam = subscript.text.startsWith('params');
      const names = isParam ? context.paramKeys : context.columns ?? [];
      if (!names.length) return null;
      const mark = subscript.text[quote];
      const escape = (name: string) => name.replace(/\\/g, '\\\\').split(mark).join(`\\${mark}`);
      return { from: subscript.from + quote + 1, options: names.map(name => ({ label: name, apply: escape(name), type: 'property', detail: isParam ? 'parameter' : 'column' })), validFor: /^[^"'\])]*$/ };
    }
    // Helpers and members are not offered inside comments or other strings.
    if (['Comment', 'String', 'FormatString'].includes(syntaxTree(completion.state).resolveInner(completion.pos, -1).name)) return null;
    // pd.read  /  scipy.stats.tt  /  df.gro
    const member = completion.matchBefore(/\b([A-Za-z_][\w.]*)\.(\w*)$/);
    if (member) {
      // The bounded interpreter has no attribute access.
      if (context.runtime === 'bounded') return null;
      const dot = member.text.lastIndexOf('.');
      const owner = member.text.slice(0, dot);
      let options = (Object.hasOwn(members, owner) ? members[owner] : []).map<Completion>(name => ({ label: name, type: 'method' }));
      if (owner === 'df' && context.columns) options = options.concat(context.columns.filter(name => identifier.test(name) && !notAttributes.has(name)).map(name => ({ label: name, type: 'property', detail: 'column', boost: 1 })));
      if (!options.length) return null;
      return { from: member.from + dot + 1, options, validFor: /^\w*$/ };
    }
    const word = completion.matchBefore(/\w+$/);
    if (!word && !completion.explicit) return null;
    return { from: word?.from ?? completion.pos, options: [...helpers(context), ...snippets(context)], validFor: /^\w*$/ };
  };
}
