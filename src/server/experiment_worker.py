"""Trusted interpreter for ros.ai's deliberately bounded Python expression subset.

User code is parsed, never passed to exec/eval. No import, attribute access,
filesystem, network, process creation, or Python object introspection is exposed.
This is application-level capability enforcement, not an OS sandbox.
"""
import ast
import csv
import io
import json
import math
import operator
import statistics
import sys

resource_limits = {}
try:
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (3, 3))
    resource_limits["cpuSeconds"] = 3
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    resource_limits["fileSizeBytes"] = 0
    # RLIMIT_AS is not reliably supported by macOS. The service reports this.
    if sys.platform != "darwin":
        resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
        resource_limits["addressSpaceBytes"] = 256 * 1024 * 1024
    else:
        resource_limits["addressSpaceBytes"] = "not enforced on macOS"
except (ImportError, ValueError, OSError) as resource_error:
    resource_limits["unavailable"] = type(resource_error).__name__
print("resource_limits=" + json.dumps(resource_limits), file=sys.stderr)

MAX_ITEMS = 10000
MAX_OUTPUTS = 20
FORBIDDEN_NAMES = {"rows", "params"}


def main():
    payload = json.loads(sys.stdin.read(1200000))
    reader = csv.DictReader(io.StringIO(payload["csv"]))
    fields = reader.fieldnames
    if not fields or len(fields) > 40 or len(set(fields)) != len(fields) or any(not h or len(h) > 200 for h in fields):
        raise ValueError("CSV needs 1–40 unique, nonempty column headers, each at most 200 characters.")
    rows = []
    for row in reader:
        if len(rows) >= MAX_ITEMS:
            raise ValueError("CSV is limited to 10,000 rows.")
        if None in row or any(value is None for value in row.values()):
            raise ValueError("Every CSV row must match its header width.")
        rows.append(row)
    if not rows:
        raise ValueError("CSV must contain at least one data row.")
    outputs = []

    def bounded_output(value):
        remaining = [30000]

        def visit(item, depth):
            remaining[0] -= 1
            if remaining[0] < 0 or depth > 10:
                raise ValueError("Output exceeds the cell-count or nesting limit.")
            if isinstance(item, dict):
                for key, nested in item.items():
                    if not isinstance(key, (str, int, float, bool)):
                        raise ValueError("Table keys must be simple labels.")
                    visit(key, depth + 1)
                    visit(nested, depth + 1)
            elif isinstance(item, list):
                for nested in item:
                    visit(nested, depth + 1)
            elif isinstance(item, str):
                if len(item) > 2000:
                    raise ValueError("Output labels/text are limited to 2,000 characters.")
            elif isinstance(item, (int, float)):
                numeric(item)
            elif item is not None:
                raise ValueError("Unsupported output value.")

        visit(value, 0)

    def numeric(value):
        result = float(value)
        if not math.isfinite(result) or abs(result) > 1e100:
            raise ValueError("Numbers must be finite and bounded by 1e100.")
        return result

    def column(name):
        if name not in fields:
            raise ValueError("Unknown column: " + str(name))
        return [numeric(row[name]) for row in rows]

    def emit(kind, title, value, labels=None):
        if len(outputs) >= MAX_OUTPUTS:
            raise ValueError("An experiment may produce at most 20 outputs.")
        if not isinstance(title, str) or not 1 <= len(title) <= 200:
            raise ValueError("Output titles must contain 1–200 characters.")
        if kind == "metric":
            value = numeric(value)
        elif kind == "plot":
            if not isinstance(value, list) or not 1 <= len(value) <= MAX_ITEMS:
                raise ValueError("A plot needs 1–10,000 numeric values.")
            value = [numeric(item) for item in value]
            if labels is not None and (not isinstance(labels, list) or len(labels) != len(value)):
                raise ValueError("Plot labels must match the value count.")
            value = {"values": value, "labels": labels}
        elif not isinstance(value, (list, dict)):
            raise ValueError("A table must be a list or dictionary.")
        bounded_output(value)
        output = {"kind": kind, "title": title, "data": value}
        if len(json.dumps(output, allow_nan=False)) > 500000:
            raise ValueError("Output exceeds 500 KB.")
        outputs.append(output)

    def describe(values):
        return [{"metric": name, "value": value} for name, value in [
            ("count", len(values)), ("mean", statistics.mean(values)),
            ("median", statistics.median(values)), ("min", min(values)),
            ("max", max(values)), ("stdev", statistics.stdev(values) if len(values) > 1 else 0),
        ]]

    def linear_fit(x, y):
        if len(x) != len(y) or len(x) < 2:
            raise ValueError("linear_fit requires equally sized x/y lists with at least two values.")
        xm, ym = statistics.mean(x), statistics.mean(y)
        xx = sum((v - xm) ** 2 for v in x)
        if not xx:
            raise ValueError("linear_fit requires nonconstant x values.")
        slope = sum((a - xm) * (b - ym) for a, b in zip(x, y)) / xx
        intercept = ym - slope * xm
        total = sum((v - ym) ** 2 for v in y)
        residual = sum((b - (slope * a + intercept)) ** 2 for a, b in zip(x, y))
        return {"slope": slope, "intercept": intercept, "r_squared": 1 - residual / total if total else 1}

    functions = {
        "column": column, "columns": lambda: fields,
        "mean": statistics.mean, "median": statistics.median,
        "stdev": statistics.stdev, "variance": statistics.variance,
        "sum": sum, "min": min, "max": max, "len": len, "sorted": sorted,
        "round": round, "abs": abs, "describe": describe, "linear_fit": linear_fit,
        "metric": lambda title, value: emit("metric", title, value),
        "table": lambda title, value: emit("table", title, value),
        "plot": lambda title, values, labels=None: emit("plot", title, values, labels),
    }
    variables = {"params": payload.get("parameters", {})}
    tree = ast.parse(payload["code"], mode="exec")
    nodes = list(ast.walk(tree))
    if len(nodes) > 2000:
        raise ValueError("Code exceeds 2,000 syntax nodes.")
    allowed = (ast.Module, ast.Assign, ast.Expr, ast.Name, ast.Load, ast.Store, ast.Constant,
               ast.Call, ast.List, ast.Tuple, ast.Dict, ast.Subscript, ast.BinOp, ast.UnaryOp,
               ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.UAdd, ast.USub)
    for node in nodes:
        if not isinstance(node, allowed):
            raise ValueError("Unsupported Python syntax: " + type(node).__name__ + ". Use the documented bounded numerical API.")
        if isinstance(node, ast.Call) and (not isinstance(node.func, ast.Name) or node.func.id not in functions):
            raise ValueError("Only the documented numerical/output functions may be called.")
        if isinstance(node, ast.Assign) and (len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name)
                                            or node.targets[0].id in functions or node.targets[0].id in FORBIDDEN_NAMES):
            raise ValueError("Assign only a simple new variable name.")
        if isinstance(node, ast.Name) and node.id.startswith("_"):
            raise ValueError("Private names are not part of the numerical API.")

    operations = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
                  ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod}

    def expression(node):
        if isinstance(node, ast.Constant):
            if isinstance(node.value, (str, int, float, bool, type(None))):
                return node.value
        elif isinstance(node, ast.Name):
            if node.id not in variables:
                raise ValueError("Unknown variable: " + node.id)
            return variables[node.id]
        elif isinstance(node, (ast.List, ast.Tuple)):
            return [expression(item) for item in node.elts]
        elif isinstance(node, ast.Dict):
            return {expression(key): expression(value) for key, value in zip(node.keys, node.values)}
        elif isinstance(node, ast.Subscript):
            value, key = expression(node.value), expression(node.slice)
            if not isinstance(value, (list, dict, str)) or not isinstance(key, (str, int)):
                raise ValueError("Only list/dictionary indexing is supported.")
            return value[key]
        elif isinstance(node, ast.UnaryOp):
            value = numeric(expression(node.operand))
            return value if isinstance(node.op, ast.UAdd) else -value
        elif isinstance(node, ast.BinOp):
            left, right = numeric(expression(node.left)), numeric(expression(node.right))
            return numeric(operations[type(node.op)](left, right))
        elif isinstance(node, ast.Call):
            return functions[node.func.id](*[expression(arg) for arg in node.args])
        raise ValueError("Unsupported expression.")

    # Validation-only mode proves the complete syntax before executing any calls.
    if not payload.get("validateOnly"):
        for statement in tree.body:
            if isinstance(statement, ast.Assign):
                variables[statement.targets[0].id] = expression(statement.value)
            elif isinstance(statement, ast.Expr):
                expression(statement.value)
            else:
                raise ValueError("Only assignments and calls are supported.")
        if not outputs:
            raise ValueError("Code produced no outputs. Call metric, table, or plot.")
    result = {"outputs": outputs, "dataset": {"columns": fields, "rowCount": len(rows)},
              "runtime": sys.version.split()[0], "resourceLimits": resource_limits, "stdout": "Validated bounded Python program." if payload.get("validateOnly") else "Executed bounded Python program; captured %d outputs." % len(outputs)}
    print(json.dumps(result, allow_nan=False))


try:
    main()
except Exception as error:
    print(type(error).__name__ + ": " + str(error)[:500], file=sys.stderr)
    sys.exit(1)
