# Local Python execution boundary

Implemented and exercised locally on September 21, 2026. The richer backend runs ordinary Python in a dedicated Docker/Linux container. The earlier numerical interpreter remains a separate compatibility backend. Neither a virtual environment nor an unrestricted host subprocess is used as the Python isolation boundary.

## Set up and verify

Start the installed Docker engine, then build the dedicated image from the repository root:

```sh
docker build -t ros-ai-research-python:1 src/server/sandbox
ROS_REQUIRE_DOCKER_TESTS=1 node --import tsx --test tests/sandbox.test.ts
```

Image build downloads the Python base and Python packages. Experiments themselves have no external network. The installed versions are Python 3.12.11, NumPy 2.2.6, pandas 2.2.3, matplotlib 3.10.3 and SciPy 1.15.3. Runtime probing checks the image's capture-worker hash against the source; rebuild after worker changes. Each backend capability snapshot includes the immutable local image ID and source/policy hash. If Docker or the matching image is unavailable, this backend fails closed. It never substitutes unrestricted host Python.

## Analysis contract

Each attempt receives a read-only copy of its captured CSV, program and JSON parameters. The worker provides `df`, `params`, `pd`, `np`, `plt` and `scipy`, and ordinary Python imports, functions, loops and library operations work inside the container. No original connection path or user folder is mounted.

```python
from scipy.stats import linregress

fit = linregress(df["rain_mm"], df["bicycle_count"])
metric("Regression slope", fit.slope)
table("Descriptive summary", df.describe().reset_index())

fig, ax = plt.subplots()
ax.scatter(df["rain_mm"], df["bicycle_count"])
ax.set(xlabel="Rainfall (mm)", ylabel="Bicycles counted")
plot("Rainfall and cycling association", fig)
export_csv("Selected observations", df)
conclusion("Describe the observed association and its uncertainty; do not infer causation from this fit.")
```

`table` captures a DataFrame, Series or JSON-compatible object. `metric` captures one value. `plot` captures a matplotlib figure as SVG; an omitted figure uses the current figure. `export_csv` captures CSV as an artifact, and `conclusion` captures text. Local-folder export is a separate host connection operation governed by its write permission. Arbitrary files left in `/work` are temporary and are removed with the container; save intended outputs through the capture helpers. stdout, stderr, tracebacks, return code and preceding captured outputs survive ordinary Python failures, allowing a new attempt to inspect and revise the failed analysis.

## Actual enforcement

The server creates containers using these controls independently of Ask / Approve for me / Full access approval policy:

- Linux network namespace with `--network=none`; external networking is disabled. Container loopback still exists.
- Read-only image filesystem; the only host bind mount is the attempt's copied input directory, also read-only. No Docker socket, original source, project directory, credentials or user's home directory is mounted.
- UID/GID 65534, all Linux capabilities dropped, `no-new-privileges`, Docker's default seccomp filter, and private PID/IPC namespaces.
- 512 MB memory, zero additional swap, one CPU quota and 32 processes; worker CPU limit 25 seconds and parent wall deadline at most 30 seconds.
- Private `/work` and `/tmp` tmpfs directories, each 64 MB and `noexec,nosuid,nodev`; per-file limit 16 MB, no core dumps and 128 open descriptors.
- Credentials are not forwarded as container environment variables. Proxy variables that Docker configuration could inject are explicitly cleared.
- At most 20 helper outputs, 500 KB per output, 2 MB total wire stdout and 100 KB stderr. Captured program text has a separate 100 KB limit. Inputs are at most 2 MB CSV / 100,000 rows / 100 columns and 100 KB code; callers may apply tighter limits.

Stop force-removes the unique container, including subprocesses. Cancellation is retried through the container-creation interval so an immediate stop cannot miss a container that appears slightly later. A separate trusted host deadline watchdog also attempts removal after abrupt server death. Working data is temporary; persisted artifact/history storage belongs to the application service.

## Limits of the claim

Python can access installed files and create processes *inside its container*. There is no unrestricted host shell, runtime package-install service, source-write capability or external network tool. Linux kernel, Docker/VM and package vulnerabilities are outside this assurance; a container is not a dedicated VM per attempt. Reliable wall-clock stop requires a responsive Docker engine. Host shutdown stops local work and provides no remote continuation.

Approval policy, connection spending allowances and connection write permissions are enforced separately by the orchestrator. An available container backend does not itself authorize any run. The `ExecutionBackend` interface also supports the September 22 Nebius remote adapter. Its standard-library contract, remote transfer approval, separate spend gate and provider limitations are described in [Nebius setup](nebius-sandbox-setup.md). Catalog access is verified; live remote execution is not. The local Docker limits here must not be attributed to the remote VM.

`tests/sandbox.test.ts` exercises actual local computation, denied host-file/input writes and external networking, environment isolation, actual cgroup/seccomp/privilege settings, failure capture, revisions, deadlines, child-process termination, immediate cancellation and output/file limits. These are local execution checks, not proof of live model planning, automatic review quality, or real-data scientific validity.

## Nebius documentation check — September 21, 2026

Nebius now documents the Sandboxes beta, including asynchronous operations with cancellation, OCI images and checkpoint branching. It describes VM-level isolation, a different boundary from the implemented local Docker backend. These are provider-documented capabilities, not ros.ai integration results. [Official sandbox overview](https://docs.tokenfactory.nebius.com/sandboxes/overview).

The official read-only image-list API requires an IAM bearer token and a separate `Project` header. The existing local configuration contains an inference key but no Nebius/Contree project setting or sandbox configuration, so account access was not verified. No instance was spawned, remote image imported, SDK installed or account changed. A future integration needs confirmed project access, pricing and separately authorized remote resource limits. [Official image-list API](https://docs.tokenfactory.nebius.com/api-reference/sandboxes/images/list-publicly-available-images).

September 22 update: the earlier documentation check above is historical. Authenticated catalog access now succeeds and the remote adapter is implemented. Pricing remains unknown, so no remote instance has been submitted. See current verification.
