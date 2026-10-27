# ros.ai Mac app

`ros.ai.app` is the local ros.ai in its own window: an Electron shell that starts the same server as `npm start` (on Electron's own Node, so nothing else needs installing) and opens it at `http://127.0.0.1:4310`. Projects, keys, the Python sandbox and agent links are the ones the CLI uses.

- `npm run app` at the repository root opens the app on this checkout, with frontend live reload.
- `npm run app:build` builds `desktop/dist/ros.ai-<version>-<arch>.dmg` and the `.app` inside it. The tools install into `desktop/node_modules` on first use.
- `.github/workflows/mac-app.yml` builds both architectures on GitHub; it signs and notarizes when the `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` secrets exist, and otherwise produces an unsigned app that macOS opens after *System Settings → Privacy & Security → Open Anyway*.

`src/main.ts` is the whole window side: pick a free port, start `dist/server/index.mjs` as a child Node process, wait for `/api/health`, open the window, send outside links to the default browser, stop the server on quit, and swap in an update. Logs are in `~/Library/Application Support/ros.ai/desktop/logs/`. The server itself is unchanged; `build.mjs` bundles it with esbuild into `dist/server/` and copies the Python helpers beside it.

## Releases and updates

1. Set the version on a branch and merge it: `npm version 0.2.0 --no-git-tag-version` (package.json and package-lock.json).
2. Tag main: `git tag v0.2.0 && git push origin v0.2.0`. The workflow stops if the tag and package.json disagree, builds both architectures, and publishes the release only once the DMG and zip of each are attached.

Installed apps see the release at their next start, within six hours, or through *ros.ai › Check for Updates…* (which opens Settings › General). The server (`src/server/updates.ts`) downloads `ros.ai-<version>-<arch>.zip`, checks its size, GitHub's SHA-256 digest and the version inside, and, once the app is signed, that the same Team ID signed it; then the Update button appears. Update quits ros.ai, replaces `ros.ai.app` (putting the old one back if the move fails, with the reason shown at the next start) and opens the new version. Electron's own autoUpdater (Squirrel.Mac) only works for Apple-signed apps, so ros.ai does this itself; it keeps working once the app is signed. An app running from the disk image or Downloads can't replace itself and links to the download instead.
