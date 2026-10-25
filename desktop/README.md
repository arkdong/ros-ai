# ros.ai Mac app

`ros.ai.app` is the local ros.ai in its own window: an Electron shell that starts the same server as `npm start` (on Electron's own Node, so nothing else needs installing) and opens it at `http://127.0.0.1:4310`. Projects, keys, the Python sandbox and agent links are the ones the CLI uses.

- `npm run app` at the repository root opens the app on this checkout, with frontend live reload.
- `npm run app:build` builds `desktop/dist/ros.ai-<version>-<arch>.dmg` and the `.app` inside it. The tools install into `desktop/node_modules` on first use.
- `.github/workflows/mac-app.yml` builds both architectures on GitHub; it signs and notarizes when the `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` secrets exist, and otherwise produces an unsigned app that macOS opens after *System Settings → Privacy & Security → Open Anyway*.

`src/main.ts` is the whole window side: pick a free port, start `dist/server/index.mjs` as a child Node process, wait for `/api/health`, open the window, send outside links to the default browser, stop the server on quit. Logs are in `~/Library/Application Support/ros.ai/desktop/logs/`. The server itself is unchanged; `build.mjs` bundles it with esbuild into `dist/server/` and copies the Python helpers beside it.
