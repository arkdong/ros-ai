# ros.ai — local tool connections

Implemented October 1, 2026. The top-right **Connections** button opens one right-side panel for Nebius Token Factory, Codex, Claude Code and Google Drive. The preceding local workspace result is preserved in [RESULT-before-connections-2026-10-01.md](RESULT-before-connections-2026-10-01.md); existing research implementation and historical milestones remain intact. [Setup guide](docs/tool-connections.md).

## What works

Connections shows account/key setup separately from research availability, with actionable controls and short blocker descriptions. It shares the right-side area with Assistant, Resources and Budget, persists the chosen view, and remains accessible before a project exists. OpenAI API and Tavily setup remain available under Other API connections.

Users can save or replace API keys through masked fields. The server writes owner-only private files, exposes only presence/source/status, and updates existing Nebius/Tavily adapters without restarting. Removing a saved key restores any startup environment setting. Nebius Check key performs only a fixed model-catalog GET. None of these actions creates or resets a spending grant; existing paid ledgers and admission checks remain.

Codex offers user-initiated native browser/device sign-in, waiting/completed/failed/expired status, cancellation and same-project sign-in resumption after closing the panel. Codex owns its authentication credentials; ros.ai holds only transient sign-in URL/code/outcome. The installed CLI’s generated schema was checked against both flows. Setup distinguishes CLI sign-in, app-server confirmation, isolation and usage permission. Research stays blocked by actual enforcement/admission gates.

Claude supports saving an Anthropic API key and checking the installed CLI’s API-only authentication selection, with official setup commands. **Embedded Claude research is not implemented**; native subscription login remains a separate external CLI workflow.

Google Drive supports privately saved OAuth Web app settings, user-completed consent, S256 PKCE, one-use browser-bound state, and server-only token exchange/refresh. The panel explicitly discloses the whole-Drive read permission before consent. It lists/searches CSV files and imports only an explicitly chosen UTF-8 CSV up to 500,000 bytes into the current project. Captures reject changed versions and retain file ID/version/modification/checksum/source URL, timestamp and content hash; later dataset use retains that provenance. Imported files do not automatically become model inputs. Local disconnect removes the token file; Drive files and imported evidence remain. Private connection routes are not mounted in public demo mode.

Relationship badges now show actual single-link wording or a multiple-link count, centered on their drawn route with exact original endpoints in tooltips and inspection. Full labels can overhang a short segment only while avoiding cards and other badges. Crowded routes retain selectable lines rather than displaced labels. Stored relationships are unchanged.

## Verification

- Final **npm run build passed** (TypeScript + Vite). Existing bundle-size advisory remains (~705 KB). No unit tests added/run or broad suites.
- Actual production browser verified top-right toggle, close/reopen, all four provider statuses, masked/disabled key setup, Codex isolation/grant details, exact Google callback and masked OAuth app form, and relationship inspection with saved endpoints. Console errors were empty. [Browser receipt](evidence/connections-2026-10-01/browser-verification.json), [panel](evidence/connections-2026-10-01/connections-panel.png), [Google setup](evidence/connections-2026-10-01/google-setup.png), [relationship inspection](evidence/connections-2026-10-01/relationship-inspection.png).
- Ten disposable credential checks covered save/load/remove, owner-only file permissions, credential-free responses, immediate adapter configuration, fixed catalog-only check and rejected-key status. All provider responses were mocked. [Receipt](evidence/connections-2026-10-01/credential-check.json).
- Disposable Google checks covered OAuth app storage, PKCE/state/cookie/replay, token refresh, fixed endpoints, bounded UTF-8/version/checksum capture and exact provenance. [Offline receipt](evidence/workspace-2026-09-30/google-drive-offline-verification.json). Native sign-in request/response/notification contracts were verified from installed CLI schemas without starting login.
- Affected direct geometry checks covered Group interiors, elbow midpoints/full labels, card/duplicate-label avoidance and omission. Browser SVG/label coordinates confirmed on-route centers; clicking a label exposed the exact saved endpoints and wording.

## Limits and current state

**No account login, real Google request, paid model request or subscription-consuming turn was started.** Native Codex sign-in was already detected; CLI 0.141.0 still lacks the required restricted read-root sandbox, and no fresh explicit bounded grant is configured. Claude’s API key is absent and its runtime remains unavailable. Google needs the user’s OAuth app settings and consent. Native sign-in completion/cancellation, live Google OAuth/import and real key acceptance remain unverified. Offline checks do not establish live integration success.

API keys and Google client/token files are unencrypted local secrets protected by owner-only file permissions; they are not an OS keychain. Model budgets are local enforced admission, not provider account billing caps. No deployment, public write, push, purchase, unit suite, new goal or automation was performed. The final local production server remains at http://127.0.0.1:4310.
