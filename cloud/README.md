# ros.ai cloud

Sign-in and the free hosted Ros, as one small service. The local app stays the product: it works without this service, and with it a person can sign in once and use Ros on NVIDIA Nemotron without a key of their own.

- **Sign-in** is [Better Auth](https://better-auth.com) with its tables in our own Postgres: people, sessions, organisations (everyone gets a personal one) and device codes. The app signs in with a device code that the person approves in the browser (`/device`), then sends the session token as a bearer token.
- **The gateway** is OpenAI-compatible (`/v1/chat/completions`, `/v1/models`, `/v1/me`), so the app's ordinary model connection and agent loop use it unchanged. The app asks for a model name (`ros`, `ros-deep`); `src/config.ts` maps each to the provider model, price and temperature, and `ROS_CLOUD_MODELS` overrides them without a code change.
- **Usage** is one row per request in `ros_usage`. A request reserves its worst-case cost before it is sent and settles to the provider's reported tokens after, so parallel requests cannot overspend the daily or total free allowance. Paid credits or billing can later read the same rows.

## Run it

```sh
cd cloud
npm ci
cp .env.example .env      # fill in DATABASE_URL, BETTER_AUTH_SECRET, NEBIUS_API_KEY
set -a; . ./.env; set +a
npm run migrate           # creates or updates every table
npm start                 # http://127.0.0.1:4400
```

Then start the app with `ROS_CLOUD_URL=http://127.0.0.1:4400 npm start` and choose **Ros, hosted by ros.ai** on the Agents page.

`docker build -t ros-ai-cloud cloud` builds an image that migrates and starts on its own, so the same service runs on Railway, Nebius AI Cloud or an organisation's own servers. Deploying it is a separate step that needs the owner's approval, because it holds the provider key.

## Numbers and errors

- `npm run metrics` (with `DATABASE_URL` set) prints sign-ups per day, weekly active people with requests and cost per person, and weekly retention. They are views over Better Auth's tables and `ros_usage` (`src/metrics.ts`), so nothing extra is collected. "Active" means at least one settled hosted Ros request in that week.
- Error reports go to Sentry only when `SENTRY_DSN` is set (`src/instrument.ts`). Reports keep the method and path, never request bodies, query strings, cookies, headers, IP addresses or console output, so prompts and tokens stay in this service.

Check: `npm run lint`.
