import { spawnSync } from 'node:child_process';

export type CodeReview = { allowed: boolean; reason: string };

// Trusted syntax inspection only. Supplied code is stdin data for ast.parse;
// it is never interpolated into this script or evaluated in the host process.
const PARSER = String.raw`
import ast, json, resource, sys
resource.setrlimit(resource.RLIMIT_CPU, (1, 1))
resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

MODULES = {
 "pandas", "numpy", "numpy.random", "numpy.linalg", "numpy.fft",
 "matplotlib", "matplotlib.pyplot", "matplotlib.dates", "matplotlib.ticker", "matplotlib.colors",
 "scipy", "scipy.stats", "scipy.optimize", "scipy.signal", "scipy.integrate", "scipy.interpolate", "scipy.linalg", "scipy.special",
 "math", "statistics", "datetime", "json", "collections", "itertools"
}
FUNCTIONS = {
 "pandas": "DataFrame Series Index MultiIndex Categorical Timestamp Timedelta to_datetime to_timedelta to_numeric date_range period_range interval_range timedelta_range concat merge merge_asof merge_ordered pivot pivot_table crosstab cut qcut get_dummies isna isnull notna notnull unique factorize",
 "numpy": "array asarray asanyarray arange linspace logspace geomspace zeros ones empty full zeros_like ones_like full_like eye identity diag diagonal where select choose clip concatenate stack vstack hstack dstack column_stack row_stack split array_split reshape ravel squeeze expand_dims transpose moveaxis swapaxes broadcast_to broadcast_arrays meshgrid tile repeat copy unique sort argsort lexsort partition argpartition take put shape size ndim mean nanmean median nanmedian average std nanstd var nanvar sum nansum prod nanprod min max amin amax nanmin nanmax argmin argmax nanargmin nanargmax quantile percentile nanquantile nanpercentile corrcoef cov histogram histogram2d histogramdd bincount digitize diff gradient cumsum cumprod sqrt cbrt square power exp expm1 log log1p log2 log10 abs absolute fabs sign round around floor ceil trunc sin cos tan arcsin arccos arctan arctan2 sinh cosh tanh degrees radians isfinite isnan isinf all any allclose isclose equal not_equal greater greater_equal less less_equal logical_and logical_or logical_not maximum minimum fmax fmin dot matmul inner outer einsum tensordot cross interp polyfit polyval poly1d trapz trapezoid nan_to_num ptp count_nonzero isin intersect1d union1d setdiff1d fromiter frombuffer finfo iinfo int8 int16 int32 int64 uint8 uint16 uint32 uint64 float16 float32 float64 bool_ datetime64 timedelta64 dtype vectorize apply_along_axis apply_over_axes fill_diagonal unravel_index ravel_multi_index nonzero flatnonzero argwhere indices result_type can_cast may_share_memory shares_memory",
 "numpy.random": "default_rng seed normal uniform random random_sample rand randn randint choice permutation shuffle binomial poisson exponential standard_normal multivariate_normal Generator PCG64",
 "numpy.linalg": "lstsq solve inv pinv norm det matrix_rank eig eigvals eigh eigvalsh svd qr cholesky cond matrix_power slogdet",
 "numpy.fft": "fft ifft rfft irfft fft2 ifft2 fftn ifftn fftfreq rfftfreq fftshift ifftshift",
 "matplotlib.pyplot": "subplots subplot figure axes plot scatter bar barh hist boxplot violinplot errorbar fill_between axhline axvline title xlabel ylabel xlim ylim xticks yticks legend grid tight_layout suptitle close subplots_adjust imshow pcolormesh contour contourf colorbar pie step stairs text annotate xscale yscale gca gcf setp get_cmap",
 "matplotlib.dates": "date2num num2date DateFormatter AutoDateLocator AutoDateFormatter ConciseDateFormatter MonthLocator YearLocator DayLocator WeekdayLocator HourLocator",
 "matplotlib.ticker": "FuncFormatter FormatStrFormatter StrMethodFormatter ScalarFormatter PercentFormatter MultipleLocator MaxNLocator AutoMinorLocator FixedLocator FixedFormatter NullFormatter NullLocator LogLocator",
 "matplotlib.colors": "Normalize LogNorm SymLogNorm TwoSlopeNorm BoundaryNorm LinearSegmentedColormap ListedColormap to_rgb to_rgba to_hex",
 "scipy.stats": "linregress pearsonr spearmanr kendalltau ttest_ind ttest_rel ttest_1samp mannwhitneyu wilcoxon kruskal friedmanchisquare f_oneway chi2_contingency chisquare fisher_exact shapiro normaltest jarque_bera kstest ks_2samp anderson levene bartlett fligner describe skew kurtosis iqr sem zscore rankdata percentileofscore trim_mean bootstrap permutation_test theilslopes siegelslopes gaussian_kde mode gmean hmean combine_pvalues probplot variation median_abs_deviation pointbiserialr",
 "scipy.optimize": "curve_fit least_squares minimize minimize_scalar root root_scalar brentq bisect newton linprog",
 "scipy.signal": "find_peaks peak_prominences peak_widths detrend savgol_filter correlate correlation_lags convolve resample resample_poly periodogram welch butter sosfilt sosfiltfilt filtfilt lfilter",
 "scipy.integrate": "quad dblquad nquad trapezoid simpson cumulative_trapezoid solve_ivp",
 "scipy.interpolate": "interp1d interp2d griddata CubicSpline PchipInterpolator UnivariateSpline RegularGridInterpolator",
 "scipy.linalg": "lstsq solve inv pinv norm det eig eigvals eigh eigvalsh svd qr cholesky toeplitz expm logm",
 "scipy.special": "expit logit softmax logsumexp erf erfc gamma gammaln beta betaln comb factorial xlogy entr rel_entr",
 "math": "ceil floor trunc fabs factorial fmod fsum gcd isclose isfinite isinf isnan lcm perm comb prod remainder exp expm1 log log1p log2 log10 pow sqrt acos asin atan atan2 cos sin tan degrees radians acosh asinh atanh cosh sinh tanh erf erfc gamma lgamma hypot dist copysign modf frexp ldexp nextafter ulp",
 "statistics": "mean fmean geometric_mean harmonic_mean median median_low median_high median_grouped mode multimode quantiles pstdev pvariance stdev variance covariance correlation linear_regression NormalDist",
 "datetime": "date datetime time timedelta timezone",
 "json": "loads dumps",
 "collections": "Counter defaultdict deque OrderedDict namedtuple ChainMap",
 "itertools": "accumulate chain combinations combinations_with_replacement compress count cycle dropwhile filterfalse groupby islice pairwise permutations product repeat starmap takewhile tee zip_longest"
}
FUNCTIONS = {key: set(value.split()) for key, value in FUNCTIONS.items()}
DISTRIBUTIONS = set("norm t chi2 f uniform beta gamma binom poisson expon lognorm multivariate_normal bernoulli nbinom weibull_min skewnorm".split())
CONSTANTS = set("nan inf pi e tau newaxis NaT NA True_ False_ int8 int16 int32 int64 uint8 uint16 uint32 uint64 float16 float32 float64 bool_ number integer floating datetime64 timedelta64 dtype UTC utc".split())
METHODS = set("mean median mode std var sum prod min max amin amax count size nunique unique describe quantile corr corrwith cov skew kurt kurtosis sem aggregate agg apply transform map applymap groupby rolling expanding ewm resample pivot pivot_table melt stack unstack explode transpose swapaxes dot round clip abs diff pct_change shift rank sort_values sort_index argsort sort reshape ravel flatten squeeze repeat take filter query eval isna isnull notna notnull dropna fillna ffill bfill interpolate replace where mask isin between duplicated drop_duplicates drop reindex reindex_like reset_index set_index rename rename_axis astype convert_dtypes infer_objects copy assign insert pop update merge join combine combine_first equals compare nlargest nsmallest head tail sample value_counts cumsum cumprod cummin cummax all any idxmin idxmax memory_usage to_numpy tolist to_list to_dict to_records to_frame to_period to_timestamp to_pydatetime tz_localize tz_convert normalize ceil floor total_seconds strftime date time year month day weekday day_name month_name isocalendar components append extend remove clear keys values items get setdefault add discard union intersection difference split rsplit splitlines strip lstrip rstrip lower upper title capitalize casefold startswith endswith contains extract extractall match fullmatch find findall len zfill pad format join encode decode count index plot hist boxplot scatter bar barh errorbar fill_between axhline axvline axhspan axvspan imshow pcolormesh contour contourf pie step stairs legend grid set set_title set_xlabel set_ylabel set_xlim set_ylim set_xticks set_yticks set_xticklabels set_yticklabels set_xscale set_yscale tick_params annotate text tight_layout suptitle subplots_adjust set_size_inches add_subplot add_axes twinx twiny set_aspect set_facecolor set_visible set_color set_linewidth set_linestyle set_major_formatter set_minor_formatter set_major_locator set_minor_locator invert_xaxis invert_yaxis get_xlim get_ylim get_legend_handles_labels get_xticklabels get_yticklabels colorbar pdf cdf ppf sf isf rvs fit interval confidence_interval normal uniform random integers choice permutation shuffle binomial poisson exponential standard_normal multivariate_normal seed split days seconds timestamp fromisoformat strptime isoformat".split())
# DataFrame query/eval evaluate an expression language and are deliberately not automatically allowed.
METHODS -= {"query", "eval", "encode", "decode"}
FORBIDDEN_NAMES = set("open exec eval compile __import__ getattr setattr delattr globals locals vars dir type object super input help breakpoint exit quit memoryview bytes bytearray format id callable property classmethod staticmethod globals builtins os sys subprocess socket pathlib requests urllib http importlib inspect ctypes pickle marshal shelve tempfile shutil multiprocessing threading concurrent resource signal atexit gc sysconfig site".split())
FORBIDDEN_ATTRS = set("os sys subprocess socket pathlib ctypes ctypeslib builtins io core internals testing tests distutils f2py lib npyio format memmap fromfile tofile fromstring read_table read_clipboard clipboard read_pickle to_pickle read_csv to_csv read_json to_json read_excel to_excel read_html to_html read_sql read_sql_query read_sql_table to_sql read_hdf to_hdf HDFStore ExcelFile ExcelWriter read_parquet to_parquet read_feather to_feather read_fwf read_orc to_orc read_xml to_xml to_latex to_markdown load loads save savez savez_compressed savetxt loadtxt genfromtxt savefig imread imsave show pause switch_backend use canvas manager system popen run call Popen fork forkpty spawn kill chdir mkdir makedirs unlink rmdir remove rename replace write read seek fileno getbuffer getvalue open_memmap mmap connect send recv bind listen accept seterrcall set_printoptions set_string_function data_as itemsize __dict__".split())
# The same innocuous method name may mean an in-memory operation on data. These
# remain unavailable as module APIs unless explicitly in FUNCTIONS above.
IN_MEMORY = {"remove", "rename", "replace", "loads", "format"}
BUILTINS = set("print len min max sum abs round sorted enumerate range zip all any int float str bool list tuple set dict frozenset reversed next iter isinstance issubclass filter map slice divmod pow hash ValueError TypeError RuntimeError KeyError IndexError ZeroDivisionError AssertionError Exception NotImplementedError StopIteration".split())
HELPERS = {"table", "metric", "plot", "export_csv", "conclusion"}
MODE = sys.argv[1] if len(sys.argv) > 1 else "code"
if MODE != "code":
    # Notebook cells run with the project folder mounted read-only and no network, so reading data files is
    # ordinary analysis. Writing files, pickles and anything unfamiliar still asks.
    READS = {"pandas": "read_csv read_table read_json read_excel read_parquet read_feather read_fwf read_stata read_spss read_sas read_xml read_orc read_html", "numpy": "load loadtxt genfromtxt fromfile"}
    for module, names in READS.items():
        FUNCTIONS[module] |= set(names.split())
    FUNCTIONS["matplotlib.pyplot"].add("show")
    FORBIDDEN_ATTRS -= set(" ".join(READS.values()).split()) | {"show"}
    HELPERS = {"display"}
AGGREGATIONS = set("sum mean median min max count size std var first last nunique sem skew kurt kurtosis prod all any".split())

class Escalate(Exception):
    pass

class Checker(ast.NodeVisitor):
    def __init__(self, carried=None):
        # A notebook cell starts from the names earlier reviewed cells set up in the same Python session.
        self.env = dict(carried) if carried is not None else {"df": "data", "params": "data", "pd": "module:pandas", "np": "module:numpy", "plt": "module:matplotlib.pyplot", "scipy": "module:scipy"}
        self.env.update({name: "call:" + name for name in BUILTINS | HELPERS})

    def fail(self, reason):
        raise Escalate(reason)

    def module_member(self, module, name):
        path = module + "." + name
        if path in MODULES:
            return "module:" + path
        if module == "scipy.stats" and name in DISTRIBUTIONS:
            return "data"
        if name in FUNCTIONS.get(module, set()):
            return "call:" + path
        if name in CONSTANTS:
            return "data"
        self.fail("Unfamiliar library member " + path + " requires human review.")

    def infer(self, node):
        if isinstance(node, ast.Name):
            return self.env.get(node.id, "data" if MODE == "code" else "unknown:" + node.id)
        if isinstance(node, ast.Attribute):
            if node.attr.startswith("_") or node.attr in FORBIDDEN_ATTRS - IN_MEMORY:
                # JSON loads is approved only as an explicit library member.
                if not (node.attr == "loads" and self.infer(node.value) == "module:json"):
                    self.fail("Dynamic or I/O attribute " + node.attr + " requires human review.")
            base = self.infer(node.value)
            if base.startswith("module:"):
                return self.module_member(base[7:], node.attr)
            if node.attr in METHODS:
                return "method:" + node.attr
            return base if base.startswith("unknown:") else "data"
        if isinstance(node, ast.Lambda):
            return "call:local-lambda"
        # Results and explicitly captured data do not become callable authority.
        return "data"

    def visit_Name(self, node):
        if node.id.startswith("__") or node.id in FORBIDDEN_NAMES:
            self.fail("Dynamic, process or I/O name " + node.id + " requires human review.")

    def visit_Attribute(self, node):
        if isinstance(node.ctx, (ast.Store, ast.Del)) and self.infer(node.value).startswith(("module:", "call:", "unknown:")):
            self.fail("Changing a library or callable requires human review.")
        self.infer(node)
        self.generic_visit(node)

    def visit_Call(self, node):
        target = self.infer(node.func)
        if target.startswith("unknown:"):
            self.fail(target[8:] + " comes from a cell the automatic reviewer did not check, or from before Python restarted. Approve this cell, or run the cell that sets up " + target[8:] + " again.")
        if not target.startswith(("call:", "method:")):
            label = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, "attr", "dynamic expression")
            self.fail("Unfamiliar or dynamic call " + label + " requires human review.")
        if any(keyword.arg is None for keyword in node.keywords):
            self.fail("Dynamic keyword expansion requires human review.")
        if any(keyword.arg in {"file", "out", "engine", "backend", "storage_options", "allow_pickle"} for keyword in node.keywords):
            self.fail("File, output and pickle options require human review.")
        if isinstance(node.func, ast.Attribute) and node.func.attr in {"agg", "aggregate", "apply", "transform", "applymap"}:
            if node.args:
                self.aggregation(node.args[0])
            elif node.func.attr in {"agg", "aggregate"}:
                for keyword in node.keywords:
                    self.aggregation(keyword.value)
        self.generic_visit(node)

    def aggregation(self, node):
        # pandas dispatches strings to methods: agg('to_pickle', ...) is I/O
        # despite the outer call looking like an ordinary statistical operation.
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if node.value not in AGGREGATIONS:
                self.fail("Unfamiliar string-dispatched aggregation requires human review.")
        elif isinstance(node, ast.Dict):
            for value in node.values:
                self.aggregation(value)
        elif isinstance(node, ast.Tuple) and len(node.elts) == 2 and isinstance(node.elts[0], ast.Constant) and isinstance(node.elts[0].value, str):
            self.aggregation(node.elts[1])
        elif isinstance(node, (ast.List, ast.Tuple)):
            for value in node.elts:
                self.aggregation(value)
        elif not self.infer(node).startswith(("call:", "method:")):
            self.fail("Dynamic aggregation callbacks require human review.")

    def bind(self, target, source):
        if isinstance(target, ast.Name):
            if target.id in HELPERS or target.id in BUILTINS:
                self.fail("Replacing a capture helper or builtin requires human review.")
            self.env[target.id] = self.infer(source) if source is not None else "data"
        elif isinstance(target, (ast.Tuple, ast.List)):
            for item in target.elts:
                self.bind(item, None)

    def visit_Assign(self, node):
        self.generic_visit(node)
        for target in node.targets:
            self.bind(target, node.value)

    def visit_AnnAssign(self, node):
        self.generic_visit(node)
        self.bind(node.target, node.value)

    def visit_Import(self, node):
        for item in node.names:
            if item.name not in MODULES:
                self.fail("Unfamiliar import " + item.name + " requires human review.")
            if (item.asname or item.name.split(".")[0]) in HELPERS | BUILTINS:
                self.fail("Replacing a capture helper or builtin requires human review.")
            self.env[item.asname or item.name.split(".")[0]] = "module:" + (item.name if item.asname else item.name.split(".")[0])

    def visit_ImportFrom(self, node):
        if node.level or node.module not in MODULES:
            self.fail("Relative or unfamiliar imports require human review.")
        for item in node.names:
            if item.name == "*":
                self.fail("Wildcard imports require human review.")
            if (item.asname or item.name) in HELPERS | BUILTINS:
                self.fail("Replacing a capture helper or builtin requires human review.")
            self.env[item.asname or item.name] = self.module_member(node.module, item.name)

    def visit_FunctionDef(self, node):
        if node.name.startswith("_") or node.name in HELPERS | BUILTINS or node.decorator_list:
            self.fail("Private/decorated functions require human review.")
        self.env[node.name] = "call:local-function"
        outer = self.env.copy()
        for arg in node.args.posonlyargs + node.args.args + node.args.kwonlyargs:
            self.env[arg.arg] = "data"
        if node.args.vararg or node.args.kwarg:
            self.fail("Dynamic function arguments require human review.")
        for default in node.args.defaults + [x for x in node.args.kw_defaults if x is not None]:
            self.visit(default)
        for statement in node.body:
            self.visit(statement)
        self.env = outer

    def visit_Lambda(self, node):
        outer = self.env.copy()
        for arg in node.args.posonlyargs + node.args.args + node.args.kwonlyargs:
            self.env[arg.arg] = "data"
        self.visit(node.body)
        self.env = outer

    def visit_For(self, node):
        self.visit(node.iter)
        self.bind(node.target, None)
        for statement in node.body + node.orelse:
            self.visit(statement)

    def visit_ClassDef(self, node):
        self.fail("Class definitions require human review.")
    def visit_Global(self, node):
        self.fail("Global mutation requires human review.")
    def visit_Nonlocal(self, node):
        self.fail("Nonlocal mutation requires human review.")
    def visit_AsyncFunctionDef(self, node):
        self.fail("Async execution requires human review.")
    def visit_NamedExpr(self, node):
        self.fail("Assignment expressions require human review.")

def carried(value):
    """Names earlier reviewed notebook cells bound. Only kinds this reviewer itself produces are accepted."""
    env = {}
    for name, kind in (list(value.items())[:2000] if isinstance(value, dict) else []):
        if not isinstance(name, str) or not name.isidentifier() or not isinstance(kind, str):
            continue
        module, _, member = kind[5:].rpartition(".")
        if kind in ("data", "call:local-function", "call:local-lambda") or (kind.startswith("module:") and kind[7:] in MODULES) \
                or (kind.startswith("method:") and kind[7:] in METHODS) or (kind.startswith("call:") and member in FUNCTIONS.get(module, ())):
            env[name] = kind
    return env

def forget(source, env):
    """After a cell runs without review, names it may have changed are no longer known, and neither are earlier
    functions, whose bodies can use those names. Anything that can change names indirectly forgets everything."""
    try:
        tree = ast.parse(source, mode="exec")
    except (SyntaxError, ValueError, RecursionError):
        return {}
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Global, ast.Nonlocal, ast.ClassDef)):
            return {}
        if isinstance(node, ast.Name):
            if node.id in FORBIDDEN_NAMES or node.id.startswith("__"):
                return {}
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                names.add(node.id)
        elif isinstance(node, ast.Attribute) and (node.attr.startswith("_") or isinstance(node.ctx, (ast.Store, ast.Del))):
            return {}
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for item in node.names:
                if item.name == "*":
                    return {}
                names.add(item.asname or item.name.split(".")[0])
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            names.add(node.name)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            names.add(node.name)
        elif isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
            names.add(node.name)
        elif isinstance(node, ast.MatchMapping) and node.rest:
            names.add(node.rest)
    return {name: kind for name, kind in env.items() if name not in names and kind not in ("call:local-function", "call:local-lambda")}

try:
    if MODE == "code":
        source, env = sys.stdin.read(20001), None
    else:
        payload = json.loads(sys.stdin.read(400001))
        source, env = payload.get("code"), carried(payload.get("env"))
        if not isinstance(source, str):
            raise Escalate("The cell source is missing.")
    if MODE == "forget":
        result = {"env": forget(source, env)}
    else:
        if not source.strip() or len(source.encode("utf-8")) > 20000:
            raise Escalate("Code must be nonempty and no larger than 20 KB.")
        tree = ast.parse(source, mode="exec")
        if sum(1 for _ in ast.walk(tree)) > 6000:
            raise Escalate("Code is too complex for automatic syntax review.")
        checker = Checker(env)
        checker.visit(tree)
        result = {"allowed": True, "reason": "Syntax review found only recognized numerical/data/plot operations and captured-output helpers. This is a conservative syntax check, not proof of research relevance or sandbox safety."}
        if MODE == "notebook":
            result["env"] = {name: kind for name, kind in checker.env.items() if not (kind == "call:" + name and name in BUILTINS | HELPERS)}
except (Escalate, SyntaxError, ValueError, RecursionError) as error:
    result = {"allowed": False, "reason": str(error)[:800] or "Python syntax could not be reviewed."}
except BaseException:
    result = {"allowed": False, "reason": "Python syntax review failed; human review is required."}
print(json.dumps(result))
`;

/** Conservative syntax reviewer, independent of actual Docker isolation and grant admission.
 * An unfamiliar program escalates; allowed never means scientifically correct or host-safe.
 * The executable override is operator/test configuration, not accepted from model/API input.
 */
export function reviewCode(code: string, options: { python?: string } = {}): CodeReview {
  if (!code.trim() || Buffer.byteLength(code, 'utf8') > 20_000) return { allowed: false, reason: 'Code must be nonempty and no larger than 20 KB for automatic review.' };
  const result = spawnSync(options.python ?? '/usr/bin/python3', ['-I', '-S', '-c', PARSER], {
    input: code, encoding: 'utf8', timeout: 1500, maxBuffer: 20_000,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C.UTF-8' },
  });
  if (result.status !== 0 || result.error) return { allowed: false, reason: 'The trusted Python syntax reviewer is unavailable or timed out; human review is required.' };
  try {
    const decision: unknown = JSON.parse(result.stdout);
    if (typeof decision !== 'object' || decision === null || !('allowed' in decision) || typeof decision.allowed !== 'boolean' || !('reason' in decision) || typeof decision.reason !== 'string') throw new Error('Invalid reviewer result.');
    return { allowed: decision.allowed, reason: decision.reason.slice(0, 1000) };
  } catch { return { allowed: false, reason: 'The trusted syntax reviewer returned an invalid result; human review is required.' }; }
}

/** What the reviewer knows about names earlier notebook cells set up in the same Python session. */
export type NotebookNames = Record<string, string>;
const notebookNames = (value: unknown): NotebookNames => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string').slice(0, 2000)) : {};
function notebookParser(mode: 'notebook' | 'forget', code: string, names: NotebookNames, python = '/usr/bin/python3'): unknown {
  const result = spawnSync(python, ['-I', '-S', '-c', PARSER, mode], {
    input: JSON.stringify({ code, env: names }), encoding: 'utf8', timeout: 1500, maxBuffer: 400_000,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C.UTF-8' },
  });
  if (result.status !== 0 || result.error) return undefined;
  try { return JSON.parse(result.stdout); } catch { return undefined; }
}
/** The same conservative review for one notebook cell. Names from earlier reviewed cells, such as
 * `import pandas as pd` or a helper function, carry over; reading data files is allowed because
 * notebook cells see the project folder read-only and have no network. */
export function reviewNotebookCell(code: string, names: NotebookNames, options: { python?: string } = {}): CodeReview & { names: NotebookNames } {
  if (!code.trim() || Buffer.byteLength(code, 'utf8') > 20_000) return { allowed: false, reason: 'Cells longer than 20 KB are not reviewed automatically.', names };
  const decision = notebookParser('notebook', code, names, options.python) as { allowed?: unknown; reason?: unknown; env?: unknown } | undefined;
  if (typeof decision?.allowed !== 'boolean' || typeof decision.reason !== 'string') return { allowed: false, reason: 'The trusted Python syntax reviewer is unavailable or timed out; human review is required.', names };
  return { allowed: decision.allowed, reason: decision.reason.slice(0, 1000), names: decision.allowed ? notebookNames(decision.env) : names };
}
/** After a cell runs without review, the names it may have changed are no longer trusted. */
export function forgetNotebookNames(code: string, names: NotebookNames, options: { python?: string } = {}): NotebookNames {
  const result = notebookParser('forget', code, names, options.python) as { env?: unknown } | undefined;
  return notebookNames(result?.env);
}
