# ros.ai Mac and Windows app

`ros.ai.app` is the local ros.ai in its own window: an Electron shell that starts the same server as `npm start` (on Electron's own Node, so nothing else needs installing) and opens it at `http://127.0.0.1:4310`. Projects, keys, the Python sandbox and agent links are the ones the CLI uses.

- `npm run app` at the repository root opens the app on this checkout, with frontend live reload. On a Mac it runs a renamed copy of Electron (`desktop/node_modules/.ros-ai-dev/ros.ai.app`) so the Dock and menu bar say ros.ai with the app icon.
- `npm run app:build` builds `desktop/dist/ros.ai-<version>-<arch>.dmg` and the `.app` inside it. The tools install into `desktop/node_modules` on first use.
- `.github/workflows/mac-app.yml` builds both architectures on GitHub; it signs and notarizes when the `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` secrets exist, and otherwise produces an unsigned app, signed ad hoc after packing (`after-pack.cjs`) so that a browser download opens after *System Settings → Privacy & Security → Open Anyway*; without that step macOS calls the bundle "damaged", because the renamed bundle no longer matches Electron's own signature. A curl download carries no quarantine mark and opens at once.

`src/main.ts` is the whole window side: pick a free port, start `dist/server/index.mjs` as a child Node process, wait for `/api/health`, open the window, send outside links to the default browser, stop the server on quit, and swap in an update. Logs are in `~/Library/Application Support/ros.ai/desktop/logs/`. The server itself is unchanged; `build.mjs` bundles it with esbuild into `dist/server/` and copies the Python helpers beside it.

## Windows

The same workflow builds `ros.ai-<version>-x64.exe` on a Windows runner (`npm run app:build` on a Windows PC does the same): a one-click NSIS installer that installs for the current person under `%LOCALAPPDATA%\Programs` without administrator rights, adds Start menu and desktop shortcuts and opens ros.ai. Data and logs are in `%APPDATA%\ros.ai`. Before the release, the workflow installs it silently, opens the installed app and saves a picture of its first window (the `windows-smoke` artifact); the run fails if the window never loads.

The installer is not code signed yet, so SmartScreen shows "Windows protected your PC" once (More info › Run anyway). To sign it, add `WIN_CSC_LINK` (a code-signing `.pfx` as base64) and `WIN_CSC_KEY_PASSWORD` as repository secrets. Windows apps do not update themselves yet: Settings › General says a new version is out and points to the installer on ros-ai.io, which installs over the old one and keeps every project.

## Signing and notarization

The workflow signs the Mac app and its disk image with a *Developer ID* certificate (Apple's proof that the app comes from you), has Apple *notarize* them (Apple scans the app and issues a ticket that macOS checks) and staples that ticket in, when five repository secrets exist. Without `CSC_LINK` it builds the unsigned app described above; with `CSC_LINK` but a missing Apple secret it stops, because a signed but un-notarized app is blocked just like an unsigned one. Its last Mac step runs `spctl`, the check Gatekeeper itself makes, and fails the run unless it says `source=Notarized Developer ID`.

The account holder of the Apple Developer Program sets it up once:

1. **APPLE_TEAM_ID**: the ten-character Team ID at [developer.apple.com/account](https://developer.apple.com/account) › Membership details.
2. **The certificate.** In Keychain Access: *Keychain Access › Certificate Assistant › Request a Certificate From a Certificate Authority*, your email, Common Name `ros.ai Developer ID`, *Saved to disk*. At [developer.apple.com › Certificates › +](https://developer.apple.com/account/resources/certificates/add) choose *Developer ID Application*, profile type *G2 Sub-CA*, upload that request and download the `.cer`. Double-click it, then in Keychain Access › login › My Certificates right-click "Developer ID Application: … (TEAMID)" › Export as `developer-id.p12` with a new password.
3. **CSC_KEY_PASSWORD** is that password. **CSC_LINK** is the file as text: `base64 -i ~/Desktop/developer-id.p12 | pbcopy`.
4. **APPLE_ID**: the Apple ID email of the developer account.
5. **APPLE_APP_SPECIFIC_PASSWORD**: at [account.apple.com](https://account.apple.com) › Sign-In and Security › App-Specific Passwords, create one named `ros.ai notarization`.

Add the five at [Settings › Secrets and variables › Actions](https://github.com/arkdong/ros-ai/settings/secrets/actions), then delete the `.p12` and the request file. To try it without a release, run the workflow by hand on a branch (*Actions › Desktop app › Run workflow*, or `gh workflow run mac-app.yml --ref <branch>`): a green run means Apple accepted both architectures, and the `ros.ai-mac-*` artifacts open with no warning. Notarization adds a few minutes per architecture. If Apple refuses with a message about agreements, accept the latest Program License Agreement at developer.apple.com/account first.

Signed releases open without any extra step, and the in-app updater starts checking that the same Team ID signed each update. Apps installed before signing still update: they are unsigned, so there is no Team ID to compare yet.

## Releases and updates

1. Set the version on a branch and merge it: `npm version 0.2.0 --no-git-tag-version` (package.json and package-lock.json).
2. Tag main: `git tag v0.2.0 && git push origin v0.2.0`. The workflow stops if the tag and package.json disagree, builds both architectures, and publishes the release only once the DMG and zip of each are attached.

Installed apps see the release at their next start, within six hours, or through *ros.ai › Check for Updates…* (which opens Settings › General). The server (`src/server/updates.ts`) downloads `ros.ai-<version>-<arch>.zip`, checks its size, GitHub's SHA-256 digest and the version inside, and, once the app is signed, that the same Team ID signed it; then the Update button appears. Update quits ros.ai, replaces `ros.ai.app` (putting the old one back if the move fails, with the reason shown at the next start) and opens the new version. Electron's own autoUpdater (Squirrel.Mac) only works for Apple-signed apps, so ros.ai does this itself; it keeps working once the app is signed. An app running from the disk image or Downloads can't replace itself and links to the download instead.
