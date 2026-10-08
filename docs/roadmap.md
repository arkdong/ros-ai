# ros.ai local release roadmap

Written October 3, 2026, after Adam set the product direction. Evidence is `file:line` as of that day; "inferred" means the code was read but the behavior was not run. ⚑ marks a decision only Adam can make.

## Product definition

ros.ai is a local research workspace that people download and run themselves, in the way DeepSeek's open-source harness or Codex CLI are run. One command serves the canvas on `127.0.0.1`. Projects, keys and the Docker Python sandbox stay on the user's machine. Model and search requests go only to the providers the user connects, and a loopback model server keeps inference local.

The Railway deployment (`ROS_PUBLIC_DEMO=1`, root `Dockerfile`) is a quick demo for showing ros.ai without installing it. It is not the product and does not set local defaults. New work is judged by whether it helps someone who downloads and runs ros.ai locally.

DNS rebinding and cross-site requests that carry an Origin header are already refused: a non-loopback Host or a foreign Origin gets 403 (`src/server/app.ts:36-44`). Requests without an Origin still pass; see gap 1.

## Before a public local release

| # | Gap | Evidence | Fix | Size |
|---|---|---|---|---|
| 1 | Requests without an Origin pass, a GET starts `codex`/`claude` setup, and there is no CSP | `app.ts:42`; `codex-agent.ts:277` | **Partly done October 6:** non-GET `/api` calls need `application/json`, `Sec-Fetch-Site: cross-site` is refused and setup is a POST. Still open: a CSP that allows CodeMirror's injected styles (`EditorView.cspNonce`) | S |
| 2 | No licence | | **Done October 3:** Adam chose MIT. `LICENSE` and the README's Licence section exclude the name, logo, other organisations' marks and third-party data | S |
| 3 | Going public ⚑ | Absolute home-directory paths in eight tracked files (e.g. `examples/demo-amsterdam/native-project.json`, `scripts/create-dutch-ai-demo.ts`); the AISO logo's embedded metadata names a person and Canva IDs; CBS reuse terms are not recorded | Decide what a public tree contains, then publish from a clean copy rather than this history | S–M |
| 4 | Every install serves the pitch deck at `/deck` | `public/deck/**` | Serve the deck only in demo mode (the OpenAI icon no longer loads from it) | S |
| 5 | It can't be installed as a command | No `bin`; `npm start` needs devDependencies (`tsx`, `vite`) | Add `bin/ros-ai.mjs`, move `tsx` to dependencies, build `dist/client` in `prepack`, add `files`. Ship `npx github:arkdong/ros-ai` first; npm publishing is a later choice | M |
| 6 | Data lives in the checkout, so reinstalling could lose it (inferred) ⚑ | `index.ts:26-27` | **Done October 6** with project folders: the OS app-data folder is the default, an existing repo-local `.ros-ai` keeps being used, and `ROS_DATA_DIR` still wins | S–M |
| 7 | The sandbox image is built by hand, and the runtime check blocks startup for up to 15 s and never reruns | `sandbox.ts:64-69` | `ros-ai doctor` / `setup` to build the image, an async check, and a Recheck button in Code | M |
| 8 | No URL printed, no flags, and the UI goes stale after `git pull` | `index.ts:105`, `index.ts:89` | Print the URL; add `--open`, `--port`, `--data-dir`, `--version`; rebuild when the version changes; check Node 24+ | S |
| 9 | Demo and pitch material appears in the local app | Demo picker on first launch (`App.tsx:49`); ABN AMRO tutorial (`tutorial-content.ts:49-50`) | Off by default locally, with one neutral Examples entry | S |
| 10 | Each project stopped running code after about 100 local runs | | **Done October 6:** Adam removed research scope and shared project limits. Runs are tallied, never blocked; each connection's allowance still caps paid calls | S |
| 11 | Code was a plain textarea | | **Done October 3:** CodeMirror editor with Python highlighting, completion and error marks (see [RESULT.md](../RESULT.md)) | M |
| 12 | The key-free AI path (a local model server) was never checked against a real server, and model IDs are typed by hand | No `/v1/models` call; `inference-connections.ts:153,161` | Ollama preset, Test connection, model list, and one live Ollama check (no cost) | S |
| 13 | Docs are written for the maintainer | `README.md`, `.env.example` | Install, quickstart and troubleshooting first; short demo section; `SECURITY.md`, `CONTRIBUTING.md` | S |

Suggested order: 1–4, then 5–6, then 7–10, then 12–13.

## Next

| # | Gap | Evidence | Fix | Size |
|---|---|---|---|---|
| 14 | Platform assumptions | `/usr/bin/python3` in `experiments.ts:59` and `review-code.ts:239`; inline `ROS_DEV=1` in `package.json` | Support macOS, Linux, and Windows through WSL2; find `python3` on PATH | S |
| 15 | No schema versions or backups before upgrades | `store.ts:95-109` | `PRAGMA user_version`, ordered migrations, automatic backup | M |
| 16 | No CI, releases or changelog | No `.github/` | GitHub Actions for typecheck, build, health check and sandbox build; tags; CHANGELOG | S–M |
| 17 | No live run output or model streaming | Polling every 1.5 s (`App.tsx:85`); `stream:false` (`inference-connections.ts:161`) | Stream stdout and model tokens. **Partly done October 7:** notebook cells stream their output | M |
| 18 | Limited data input | UTF-8 CSV up to 500 KB (`connections.ts:13`); one input per Code block | Larger local limit, named inputs, xlsx/parquet | S–M |
| 19 | Fixed packages and a 30 s limit | `sandbox/Dockerfile`; `sandbox.ts:63` | User requirements at image build; configurable local limits | M |
| 20 | No project export or import | Partly covered October 6: a project folder reopens elsewhere with its blocks, layout and connections, but not its runs or history | Hash-checked project bundle | M |
| 21 | Merging to `main` redeploys the demo ⚑ | Railway builds `main` | Deploy the demo from a `demo` branch | S |
| 22 | Dead demo code | `start:'demo'` looks unreachable (`App.tsx:229`, inferred); unused `hosting` (`tutorial.ts:60-62`) | Remove it and group demo files | S |
| 23 | A blank project only suggests Knowledge or Action | `Canvas.tsx:546` | Empty state with New Code, Import CSV and Connect local model | S |
| 24 | No access token on loopback | `app.ts:36-44` | Optional per-launch token in a cookie, as Jupyter does | M |
| 25 | Code editing happens in a dialog | Code opens in `Modal` (`App.tsx`) | Full-height panel or route for Code | M |
| 26 | Completion is static | `src/client/code/python-completions.ts` | Optional AI completion through a local model (needs a fill-in-the-middle adapter path) | M |

## Later

- Fall back to another port when 4310 is busy (`index.ts:104`).
- Keys in the OS keychain instead of a 0600 JSON file (`tool-credentials.ts:45`).
- Search across projects.
- A web search adapter besides Tavily.
- Check whether current Codex CLI supports restricted read roots (`codex-agent.ts:67`).
- C and Haskell: real runtimes, or remove them from the language list.
- A prebuilt sandbox image on GHCR ⚑, Homebrew, a desktop app, a headless CLI mode.
