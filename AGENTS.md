# ros.ai Agent Instructions

## Read first

Read `README.md`, `docs/guide.md` and `docs/architecture.md` before implementation. `CONTEXT.md` has the words the product uses. Current user instructions take precedence.

## Product boundaries

- Use ros.ai for the product and ros-ai for repository and filesystem names. The assistant is ROS.
- ros.ai is the open workspace that holds a project's context on one canvas, where agents from any vendor work in the open. It is not an automation pipeline: blocks work independently, and a link is one word between two blocks that never schedules, blocks or imports anything.
- The person owns the structure of the canvas. Only an explicit Group contains blocks; Groups nest without cycles.
- Manual edits are direct and undoable. Layout and view changes are saved without entering history or discarding Redo. What an agent proposes follows the project's permission mode, with visible provenance and Undo; a write to an outside app always asks.
- The product is the downloadable local app: started from the command line or the Mac and Windows app, served on loopback, with a browser page. There is no hosted version of the app. Model, search and plugin calls are outside connections the person sets up. Keep credentials on the server side.
- ros.ai cloud (sign-in, the hosted ROS gateway and the usage ledger) lives in the separate private repository `arkdong/ros-ai-cloud`, under its own licence. It keeps the provider key on its side, and the local app works without it.
- Generated code runs only in the Python sandbox or in a sealed App frame, and an agent works within the permissions and resources it was given.
- Treat architectural recommendations as implementation defaults, not claims of completed code.

## Engineering and verification

- Inspect the actual state and preserve unrelated or concurrent edits.
- Keep modules and interfaces focused on real consumers.
- Iterate fast without broad defensive suites. Use the type check, the build and direct checks of what you changed; preserve data and authorization safeguards. `npm test` passes and CI runs it on every pull request: keep it passing, update a test whose behaviour you change on purpose, and add one focused test with a bug fix.
- Verify the actual UI in a browser. Mocks support tests but do not establish that a live integration works.
- Adam prefers lean, focused verification: reuse passing checks and avoid repeating broad suites or build and restart cycles unless a concrete new change, failure or risk justifies them.
- Preserve model-visible request inputs and saved output versions, not claims of hidden reasoning or deterministic model replay.

## Safety and cost

- Never commit credentials, private keys, account data or private personal data.
- Get explicit approval before deployments, purchases, account changes, or public or shared writes.
- Paid verification requires fresh explicit budget authorization; an earlier allowance is not permission for new calls. Use configured credentials only; do not purchase or redeem credits.
- No unrestricted shell, package installation, filesystem or network tool may be exposed by the Python sandbox. Report approval policy and actual enforcement separately.

## Durable context

Project status and implementation truth belong in this repository: the README, `docs/guide.md` and `docs/architecture.md`. Strategy, pitch and dated build records are kept outside the repository.
