# Nebius deployment

The cloud gateway (the private repository [`arkdong/ros-ai-cloud`](https://github.com/arkdong/ros-ai-cloud)) and the public demo (this repository's root `Dockerfile`) run on one Nebius VM, behind Caddy for HTTPS. The gateway's database is Nebius Managed PostgreSQL. The VM setup is in `deploy/nebius/`; the same Dockerfiles still run on any other host.

| Address | Service | Health |
| --- | --- | --- |
| https://cloud.ros-ai.io | gateway and sign-in | `/health` |
| https://demo.ros-ai.io | public demo | `/api/health` |

Settings stay on the VM in `/etc/ros-ai/`, never in a repository. `.github/workflows/deploy-nebius.yml` deploys both services on a push to this repository's `main` that touches the app or `deploy/nebius/`, and on a push to `ros-ai-cloud`'s `main` (its own workflow sends this repository the `deploy-cloud` event). Each deploy copies this repository to `/opt/ros-ai` and the gateway to `/opt/ros-ai-cloud` on the VM, then rebuilds whatever changed.

## First setup

1. **Database.** In the Nebius console, create a Managed PostgreSQL cluster in the same EU region as the VM, with the smallest preset. Note the host, user, password and database name, and download the cluster's CA certificate.
2. **VM.** Create a CPU-only VM (2 vCPU and 8 GB is plenty) with Ubuntu, a public IP and your SSH key. Allow its address in the database's network access.
3. **Prepare the VM.** Copy `deploy/nebius/bootstrap.sh` to the VM and run `bash bootstrap.sh`, then log out and back in.
4. **Settings.** On the VM, put the CA certificate at `/etc/ros-ai/postgres-ca.pem` and create `/etc/ros-ai/cloud.env` from `ros-ai-cloud`'s `.env.example`, with the same values as the Railway cloud service except:
   ```dotenv
   DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DB?sslmode=verify-full&sslrootcert=/certs/postgres-ca.pem
   ROS_CLOUD_URL=https://cloud.ros-ai.io
   ```
   Then `chmod 600 /etc/ros-ai/*`.
5. **Deploy key.** Make a key pair only for deploys (`ssh-keygen -t ed25519 -f ros-ai-deploy -N ''`), add the public half to the VM's `~/.ssh/authorized_keys`, and set the GitHub repository secrets of `ros-ai`: `NEBIUS_SSH_HOST` (VM IP), `NEBIUS_SSH_USER` and `NEBIUS_SSH_KEY` (private half).
6. **Access to the gateway's repository.** The workflow checks out the private `ros-ai-cloud`, so it needs a token: on GitHub, Settings → Developer settings → Fine-grained tokens, limited to the repository `ros-ai-cloud` with the permission Contents: read-only. Save it as the `ros-ai` repository secret `ROS_AI_CLOUD_TOKEN`. For the other direction (a gateway push deploys on its own), make a second fine-grained token limited to `ros-ai` with Contents: read and write, and save it in `ros-ai-cloud` as the secret `ROS_AI_DEPLOY_TOKEN`; without it, deploy a gateway change by running the workflow by hand.
7. **DNS.** In Cloudflare, add an `A` record `demo` → VM IP, **DNS only** (grey cloud), so Caddy can get its certificate. `cloud` stays on Railway until the switch below.
8. **First deploy.** Run the "Deploy to Nebius" workflow by hand (Actions tab). Check https://demo.ros-ai.io/api/health.

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
3. **Check.** https://cloud.ros-ai.io/health returns `{"ok":true}`; sign in from the app; run one hosted Ros request; in a checkout of `ros-ai-cloud`, `DATABASE_URL=… npm run metrics` shows the copied accounts.
4. **Close Railway** after a few quiet days: delete the cloud service, its Postgres and the demo service. (Until then, the Railway cloud service must build from `arkdong/ros-ai-cloud` with root directory `/`, since `cloud/` no longer exists in this repository.)

## Day to day

- Logs: `cd /opt/ros-ai/deploy/nebius && docker compose logs -f cloud` (or `demo`, `caddy`).
- Change a setting: edit `/etc/ros-ai/cloud.env`, then `docker compose up -d cloud`.
- Visitor workspaces of the demo live in the `demo-data` volume; the gateway keeps nothing on the VM.
