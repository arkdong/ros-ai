# Railway public demonstration

Prepared September 23, 2026. The curated Docker image built successfully locally; no live Railway deployment is established. The user requested deployment, but automatic approval review blocked GitHub sign-in while direct confirmation is pending. No hosting purchase is authorized by the separate model-experiment budget.

The public demo needs the Node backend and persistent storage, not a static frontend host. `Dockerfile` builds the browser frontend, runs the Node 24 server with its existing `tsx` runtime, and includes only the attributed banking scenario. `ROS_PUBLIC_DEMO=1` selects the visitor demo service rather than the local private workspace. Visitor stores live beneath the configured public data directory; do not mount or upload `.ros-ai`.

## Service settings

Use the repository root and its `Dockerfile`. Railway detects Dockerfiles independently of application config. For a new service, set the following in the dashboard: start command `node --import tsx src/server/index.ts`, one replica, healthcheck `/api/health`, healthcheck timeout 100 seconds, and an on-failure restart policy. No `railway.json` is supplied: Railway's current documentation says new services cannot adopt that deprecated config format, and existing support ends December 1, 2026. [Dockerfile detection](https://docs.railway.com/builds/dockerfiles), [config format status](https://docs.railway.com/config-as-code).

Set these server variables:

| Variable | Value |
| --- | --- |
| `ROS_PUBLIC_DEMO` | `1` |
| `ROS_PUBLIC_ORIGIN` | The exact public HTTPS origin, without a trailing path; alternatively use the service's `RAILWAY_PUBLIC_DOMAIN` |
| `ROS_DATA_DIR` | `/data/visitor-workspaces` |
| `PORT` | Railway-provided port; image fallback is `8080` |

Generate the Railway domain, confirm the selected target port, and configure the exact origin before directing visitors to it. The public server listens on all interfaces; local mode remains on loopback. [Public networking](https://docs.railway.com/networking/public-networking).

Attach a persistent volume at `/data`. Keep this deployment to one service instance: visitor SQLite stores and process locks are local to that volume. Railway mounts volumes at service startup as root; the supplied Node image retains that UID so it can create the visitor directories. Nothing is initialized into the volume during the image build. [Volume persistence, availability and permissions](https://docs.railway.com/volumes).

The waitlist is retired. Preserve any existing `/data/visitor-workspaces/waitlist.sqlite` on the same volume; the application no longer opens or changes it. Do not upload a local database containing private email addresses.

## What visitors can do

Share `/app` for the demonstration; the domain root redirects to the website at https://ros-ai.io. Legacy `/waitlist` and `/waitlist/pitch` links redirect to `/app`; the retired signup/count API returns 410.

The banking tutorial creates an independent visitor workspace and progressively loads four stages, attributed evidence, genuine saved calculations, figures and the cited draft. The public image contains no Docker daemon or Python runner. New code execution and paid model/search requests remain disabled in public demo mode. Local ros.ai retains its separately approved rerun controls and provider settings. Railway Sandboxes would be a separate execution integration; this deployment does not implement that adapter or establish its cost authorization.

The market scenario remains available locally. Its S&P/FRED CSV, saved figures and market result bundle are omitted from both the Docker build context and final image because public reproduction permission is unresolved. No substitute values or simulated success are supplied.

`.dockerignore` allows only the necessary source, public brand assets and four banking dependencies. The Dockerfile never copies `.env*`, local project databases, private evidence, output folders, vault memory or the market dataset. Provider credentials are unnecessary for this public demonstration and must not be uploaded. Future authorized provider use would require server-side service variables and the existing separate spending controls.

After an approved deployment, verify `/api/health`, one banking tutorial through its draft, and a second browser session's separate workspace. Record the deployed URL and actual result in `RESULT.md`; do not describe the public service or runner as verified until that smoke has happened.

## Remaining live-execution integration

This image is the fast recorded-tutorial slice. Hosting it does not complete the requested executable public application. A minimal implementation can reuse the existing Nebius remote backend, but must compose a visitor-scoped ExperimentService API with a shared server-wide budget store (never a new grant per visitor), bounded concurrency, exact code/input review, durable remote-operation recovery and cancellation. Active visitor stores cannot be evicted while attempts use them. The current tutorial uses pandas/matplotlib; the verified remote contract is Python standard library, requiring an equivalent reviewed program or a separately verified richer image.

That integration is additional code, not just Railway variables. Actual calls also require known cost units/verified rates or explicit beta terms and a fresh sandbox allowance. Existing model authorization is not remote-execution authorization. The current public server has no provider credentials, execution endpoints or capability to spend. Do not expose local-mode APIs directly to the public to work around this boundary.
