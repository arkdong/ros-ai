# ros.ai Mac app

`ros.ai.app` is the local ros.ai in its own window: an Electron shell that starts the same server as `npm start` (on Electron's own Node, so nothing else needs installing) and opens it at `http://127.0.0.1:4310`. Projects, keys, the Python sandbox and agent links are the ones the CLI uses.

- `npm run app` at the repository root opens the app on this checkout, with frontend live reload. On a Mac it runs a renamed copy of Electron (`desktop/node_modules/.ros-ai-dev/ros.ai.app`) so the Dock and menu bar say ros.ai with the app icon.
- `npm run app:build` builds `desktop/dist/ros.ai-<version>-<arch>.dmg` and the `.app` inside it. The tools install into `desktop/node_modules` on first use.
- `.github/workflows/mac-app.yml` builds both architectures on GitHub; it signs and notarizes when the `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` secrets exist, and otherwise produces an unsigned app, signed ad hoc after packing (`after-pack.cjs`) so that a browser download opens after *System Settings → Privacy & Security → Open Anyway*; without that step macOS calls the bundle "damaged", because the renamed bundle no longer matches Electron's own signature. A curl download carries no quarantine mark and opens at once.

`src/main.ts` is the whole window side: pick a free port, start `dist/server/index.mjs` as a child Node process, wait for `/api/health`, open the window, send outside links to the default browser, stop the server on quit, and swap in an update. Logs are in `~/Library/Application Support/ros.ai/desktop/logs/`. The server itself is unchanged; `build.mjs` bundles it with esbuild into `dist/server/` and copies the Python helpers beside it.

## Signing and notarization

The workflow signs and notarizes when five repository secrets exist (Settings › Secrets and variables › Actions). They come from an Apple Developer Program membership:

1. **APPLE_TEAM_ID**: the ten-character Team ID shown at developer.apple.com › Membership details.
2. **CSC_LINK** and **CSC_KEY_PASSWORD**: a *Developer ID Application* certificate. In Xcode › Settings › Accounts › Manage Certificates, press + and choose Developer ID Application (or create it at developer.apple.com › Certificates). Then in Keychain Access, find "Developer ID Application: <name> (<team>)", right-click › Export as `.p12` with a password. `CSC_KEY_PASSWORD` is that password; `CSC_LINK` is the file as base64: `base64 -i ~/Desktop/developer-id.p12 | pbcopy`. Delete the `.p12` afterwards.
3. **APPLE_ID**: the Apple ID email of the account.
4. **APPLE_APP_SPECIFIC_PASSWORD**: at account.apple.com › Sign-In and Security › App-Specific Passwords, create one named "ros.ai notarization".

Then tag the next version. Notarization adds about five minutes per architecture; the log says "notarization successful". Signed releases open without any step, and the in-app updater starts checking that the same Team ID signed each update.

## Releases and updates

1. Set the version on a branch and merge it: `npm version 0.2.0 --no-git-tag-version` (package.json and package-lock.json).
2. Tag main: `git tag v0.2.0 && git push origin v0.2.0`. The workflow stops if the tag and package.json disagree, builds both architectures, and publishes the release only once the DMG and zip of each are attached.

Installed apps see the release at their next start, within six hours, or through *ros.ai › Check for Updates…* (which opens Settings › General). The server (`src/server/updates.ts`) downloads `ros.ai-<version>-<arch>.zip`, checks its size, GitHub's SHA-256 digest and the version inside, and, once the app is signed, that the same Team ID signed it; then the Update button appears. Update quits ros.ai, replaces `ros.ai.app` (putting the old one back if the move fails, with the reason shown at the next start) and opens the new version. Electron's own autoUpdater (Squirrel.Mac) only works for Apple-signed apps, so ros.ai does this itself; it keeps working once the app is signed. An app running from the disk image or Downloads can't replace itself and links to the download instead.
