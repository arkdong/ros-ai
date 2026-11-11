# The Python sandbox

Code and Notebook blocks run Python inside a boundary the operating system enforces, whatever the project's permission mode is. There are two, chosen by the computer:

- **On a Mac:** ros.ai's own Python inside the macOS sandbox. Nothing to install.
- **On Linux and Windows:** a dedicated Docker container.

ros.ai never falls back to unconfined Python on the computer. When neither boundary is available, the block says so and does not run.

## On a Mac

The first time a block runs, ros.ai fetches Python 3.12 with [uv](https://docs.astral.sh/uv/) into its app-data folder (about 150 MB, once), with NumPy 2.2.6, pandas 2.2.3, matplotlib 3.10.3 and SciPy 1.15.3. The download of uv itself is checked against a pinned checksum.

Each run starts under `sandbox-exec` with a profile that denies everything and then allows only this (`src/server/local-python.ts`):

- Reading the system's own files, ros.ai's Python, and the folders the run was given: its private working folder, and for a Notebook the project's folder. The rest of the home folder and other drives cannot be read.
- Writing to the run's working folder and a private temporary folder.
- Network to one address: ros.ai's own proxy on this computer (`src/server/network-gate.ts`). The proxy asks before a run reaches a new website (once, always for this project, or no), and Settings can allow every site. PyPI is always allowed, so `%pip install` works in a notebook.

This is the same kind of boundary Claude Code and Codex use for commands. It is not a virtual machine: a flaw in macOS's sandbox is outside what it promises.

## In Docker

Start Docker, then build the image from the repository root:

```sh
docker build -t ros-ai-research-python:1 src/server/sandbox
ROS_REQUIRE_DOCKER_TESTS=1 node --import tsx --test tests/sandbox.test.ts
```

The image holds the same Python and package versions. ros.ai checks the image's worker against the source before every run, so rebuild after changing a file in `src/server/sandbox/`. If Docker or the matching image is missing, the run is refused.

## What a Code block's program gets

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

## What the container enforces

The server creates each container with these controls, whatever the permission mode:

- Linux network namespace with `--network=none`; external networking is disabled. Container loopback still exists.
- Read-only image filesystem; the only host bind mount is the attempt's copied input directory, also read-only. No Docker socket, original source, project directory, credentials or user's home directory is mounted.
- UID/GID 65534, all Linux capabilities dropped, `no-new-privileges`, Docker's default seccomp filter, and private PID/IPC namespaces.
- 512 MB memory, zero additional swap, one CPU quota and 32 processes; worker CPU limit 25 seconds and parent wall deadline at most 30 seconds.
- Private `/work` and `/tmp` tmpfs directories, each 64 MB and `noexec,nosuid,nodev`; per-file limit 16 MB, no core dumps and 128 open descriptors.
- Credentials are not forwarded as container environment variables. Proxy variables that Docker configuration could inject are explicitly cleared.
- At most 20 helper outputs, 500 KB per output, 2 MB total wire stdout and 100 KB stderr. Captured program text has a separate 100 KB limit. Inputs are at most 2 MB CSV / 100,000 rows / 100 columns and 100 KB code; callers may apply tighter limits.

Stop force-removes the unique container, including subprocesses. Cancellation is retried through the container-creation interval so an immediate stop cannot miss a container that appears slightly later. A separate trusted host deadline watchdog also attempts removal after abrupt server death. Working data is temporary; persisted artifact/history storage belongs to the application service.

## Limits of the Docker boundary

Python can access installed files and create processes *inside its container*. There is no unrestricted host shell, runtime package-install service, source-write capability or external network tool. Linux kernel, Docker/VM and package vulnerabilities are outside this assurance; a container is not a dedicated VM per attempt. Reliable wall-clock stop requires a responsive Docker engine. Host shutdown stops local work and provides no remote continuation.

Permission modes and write permissions are enforced separately, by the server. An available sandbox does not by itself allow a run.

`tests/sandbox.test.ts` exercises actual local computation, denied host-file/input writes and external networking, environment isolation, actual cgroup/seccomp/privilege settings, failure capture, revisions, deadlines, child-process termination, immediate cancellation and output/file limits. These are local execution checks, not proof of live model planning, automatic review quality, or real-data scientific validity.

`tests/local-python.test.ts` checks the Mac profile: everything denied by default, the home folder closed, and no network except the proxy.
