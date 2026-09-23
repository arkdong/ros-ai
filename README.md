# ros.ai public demonstration release

Prepared September 23, 2026. This is a sanitized source snapshot for the public banking demonstration. It contains the application, public brand assets, and the four attributed banking dependencies needed by `Dockerfile`. No existing user workspace or provider credential is included.

Railway detects the root Dockerfile. Run one service instance with a persistent volume mounted at `/data`; use start command `node --import tsx src/server/index.ts` and healthcheck `/api/health`. Set `ROS_PUBLIC_DEMO=1`, `ROS_DATA_DIR=/data/visitor-workspaces`, and the exact HTTPS `ROS_PUBLIC_ORIGIN` (or use `RAILWAY_PUBLIC_DOMAIN`). The server respects `PORT`; the image fallback is 8080.

Visitors receive separate demo workspaces. Four guided steps load attributed evidence, genuine saved analysis outputs and a finished research draft. Public demo mode does not run code or make paid provider requests. No provider keys are needed.

The market scenario's restricted S&P/FRED dataset, figures and saved result bundle are deliberately absent. It remains a local-only scenario. The release also excludes `.env*`, private databases, Git metadata, local dependencies, vault memory, private evidence and output folders.

`RELEASE-MANIFEST.json` records included file paths and SHA-256 hashes. This repository contains the prepared source release; a Railway deployment is still a separate step. A local Docker build succeeded as `ros-ai-public-demo:20260923`; this image was not pushed. Live deployment remains a separate action and has not been established by this release snapshot.

A disposable container runtime smoke passed on localhost:4312: health returned public-demo mode; one banking workspace advanced through all four stages and exposed 11 saved outputs, two plots and a 6,549-character draft. No new execution run or fresh output was created, and no paid provider request was made. The container used no secrets or host data mounts and was stopped and removed afterward. This verifies the packaged Node/backend/data path locally; it does not establish a live Railway deployment.

## Import into Railway

1. Choose **New Project → Deploy from GitHub repo → arkdong/ros-ai** and the `main` branch. Railway should detect the root `Dockerfile`.
2. Use one replica and attach a volume mounted at `/data` so visitor workspaces survive deployments.
3. Generate a public domain in the service's Networking settings. The application reads `RAILWAY_PUBLIC_DOMAIN` automatically; alternatively set `ROS_PUBLIC_ORIGIN` to that exact HTTPS origin. If the first start preceded domain creation, redeploy after the domain is available.
4. Use healthcheck `/api/health`. The Dockerfile supplies the start command and `ROS_PUBLIC_DEMO=1`; no API keys or local data uploads are needed.
5. Open the generated URL and choose **Start demo**. This deployment serves the saved-results banking tutorial. Fresh model calls and Python execution are unavailable in this public release.

## Waitlist and pitch count

Share `/waitlist` on your deployed domain for a simple email signup. Open `/waitlist/pitch` while presenting for a large signup count that refreshes every five seconds. Links are also available from the app header and demo chooser.

The count is unique normalized email submissions, not verified users; duplicate addresses do not increase it. Only the aggregate count is public. The app stores email addresses privately on the server and does not send email or expose a public email list.

Signups are shared across visitors and stored separately from demo workspaces in `ROS_DATA_DIR/waitlist.sqlite`. Keep the existing `/data` persistent volume and one replica so the list survives Railway redeployments. Each installation has its own count; the local development count is separate from Railway. Test signups were confined to a disposable local database and are not included in this release.
