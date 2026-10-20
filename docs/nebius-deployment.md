# Nebius deployment

The cloud gateway (`cloud/`) and the public demo (root `Dockerfile`) run on one Nebius VM, behind Caddy for HTTPS. The gateway's database is Nebius Managed PostgreSQL. Everything is in `deploy/nebius/`; the same Dockerfiles still run on any other host.

| Address | Service | Health |
| --- | --- | --- |
| https://cloud.ros-ai.io | gateway and sign-in | `/health` |
| https://demo.ros-ai.io | public demo | `/api/health` |

Settings stay on the VM in `/etc/ros-ai/`, never in the repository. A push to `main` that touches the gateway, the app or `deploy/nebius/` deploys through `.github/workflows/deploy-nebius.yml`.

## First setup

1. **Database.** In the Nebius console, create a Managed PostgreSQL cluster in the same EU region as the VM, with the smallest preset. Note the host, user, password and database name, and download the cluster's CA certificate.
2. **VM.** Create a CPU-only VM (2 vCPU and 8 GB is plenty) with Ubuntu, a public IP and your SSH key. Allow its address in the database's network access.
3. **Prepare the VM.** Copy `deploy/nebius/bootstrap.sh` to the VM and run `bash bootstrap.sh`, then log out and back in.
4. **Settings.** On the VM, put the CA certificate at `/etc/ros-ai/postgres-ca.pem` and create `/etc/ros-ai/cloud.env` from `cloud/.env.example`, with the same values as the Railway cloud service except:
   ```dotenv
   DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DB?sslmode=verify-full&sslrootcert=/certs/postgres-ca.pem
   ROS_CLOUD_URL=https://cloud.ros-ai.io
   ```
   Then `chmod 600 /etc/ros-ai/*`.
5. **Deploy key.** Make a key pair only for deploys (`ssh-keygen -t ed25519 -f ros-ai-deploy -N ''`), add the public half to the VM's `~/.ssh/authorized_keys`, and set the GitHub repository secrets `NEBIUS_SSH_HOST` (VM IP), `NEBIUS_SSH_USER` and `NEBIUS_SSH_KEY` (private half).
6. **DNS.** In Cloudflare, add an `A` record `demo` → VM IP, **DNS only** (grey cloud), so Caddy can get its certificate. `cloud` stays on Railway until the switch below.
7. **First deploy.** Run the "Deploy to Nebius" workflow by hand (Actions tab). Check https://demo.ros-ai.io/api/health.

## Moving the gateway from Railway

1. **Copy the data**, on the VM. Take the Railway Postgres public URL from its Connect tab. `--clean` replaces the empty tables the new gateway created on its first start.
   ```sh
   cd /opt/ros-ai/deploy/nebius && docker compose stop cloud
   docker run --rm -v /etc/ros-ai/postgres-ca.pem:/certs/postgres-ca.pem:ro \
     -e FROM='RAILWAY_PUBLIC_URL' -e TO='NEBIUS_DATABASE_URL' postgres:18 sh -c \
     'pg_dump --clean --if-exists --no-owner --no-acl "$FROM" | psql -v ON_ERROR_STOP=1 "$TO"'
   docker compose start cloud
   ```
   Sign-ins or Ros requests made on Railway after the dump are not copied, so do this at a quiet moment.
2. **Switch DNS.** Point `cloud` at the VM IP (DNS only). Caddy gets the certificate on the first request.
3. **Check.** https://cloud.ros-ai.io/health returns `{"ok":true}`; sign in from the app; run one hosted Ros request; `cd cloud && DATABASE_URL=… npm run metrics` shows the copied accounts.
4. **Close Railway** after a few quiet days: delete the cloud service, its Postgres and the demo service.

## Day to day

- Logs: `cd /opt/ros-ai/deploy/nebius && docker compose logs -f cloud` (or `demo`, `caddy`).
- Change a setting: edit `/etc/ros-ai/cloud.env`, then `docker compose up -d cloud`.
- Visitor workspaces of the demo live in the `demo-data` volume; the gateway keeps nothing on the VM.
