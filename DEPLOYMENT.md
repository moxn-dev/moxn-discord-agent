# Deployment guide

## Recommended shape

Run the provided Docker image as exactly one continuously running process with a
persistent volume mounted at `/data`. The service needs outbound HTTPS plus the
Discord Gateway connection, but no inbound application port.

For a personal deployment, a small Linux VM is the clearest default:

1. **AWS Lightsail or EC2 + Docker Compose** — recommended reference path. It is
   easy to understand, gives Codex a normal persistent filesystem, and avoids
   adding managed-container storage and interactive-login complexity.
2. **Railway, Fly.io, or a Render background worker** — lower-operations options.
   Attach a persistent volume, keep one instance always running, and use the
   provider's secret store.
3. **ECS/Fargate** — viable when the operator already uses AWS container
   infrastructure, but persistent Codex state requires EFS or another durable
   mount. It is unnecessary complexity for one assistant.

Do not use Vercel Functions, Lambda-style request handlers, or any platform that
sleeps the process when HTTP traffic is absent. Discord Gateway and Temporal task
pollers are long-lived outbound connections.

## Docker Compose

Create `.env`, then build the image:

```bash
cp .env.example .env
docker compose build
```

Authenticate the isolated Codex home in the persistent volume:

```bash
docker compose run --rm --entrypoint sh agent -lc \
  'mkdir -p "$CODEX_HOME" && ./node_modules/.bin/codex login --device-auth'
```

Start the one replica:

```bash
docker compose up -d
docker compose logs -f agent
```

Stop cleanly with `docker compose down`. Do not add `--volumes` unless you intend
to delete the Codex login, sessions, runtime workspace, and attachment inbox.

## AWS Lightsail or EC2

For this low-throughput but occasionally memory-bursty process, start with 2 GB
RAM on x86-64 Linux. A 1 GB host can work, but Codex plus the Temporal workflow
bundle has less headroom.

1. Create an Ubuntu or Debian VM.
2. Restrict inbound access to SSH from your address, or use AWS Systems Manager.
   The agent needs no public application port.
3. Install Docker Engine and its Compose plugin from Docker's official packages.
4. Clone this repository and create `.env` with mode `0600`.
5. Run the Docker Compose authentication and startup commands above.
6. Enable provider disk encryption, automatic VM snapshots, and a billing alert.

Docker's `restart: unless-stopped` brings the process back after crashes and host
reboots. Back up the `agent-data` volume as sensitive material.

## Railway

- Deploy from the `Dockerfile` as one service.
- Create a volume mounted at `/data`.
- Set `AGENT_DATA_DIR=/data` and `CODEX_HOME=/data/codex`.
- Add every `.env.example` secret through Railway Variables.
- Use Railway's shell to run `codex login --device-auth` once against the mounted
  volume.
- Keep one replica running; do not enable serverless sleep behavior.

Railway's Hobby plan includes a persistent-volume allowance and is convenient for
an experiment. Resource usage is billed separately when it exceeds the plan's
included credit.

## Fly.io

- Create one Machine from the `Dockerfile`.
- Mount a Fly Volume at `/data`.
- Store credentials with `fly secrets`.
- Run the device login through `fly ssh console`.
- Disable automatic stop/suspend. This worker has no inbound request that could
  reliably wake it when a Discord message arrives.

## Render

Use a paid background worker, not a free web service. Attach a persistent disk at
`/data`, configure environment secrets, and run one instance. Render's filesystem
is otherwise ephemeral, and free services do not support this continuous
stateful-worker shape.

## Persistence and secrets

The `/data` volume contains:

- Codex subscription credentials and session logs;
- the runtime copy of `AGENTS.md`;
- downloaded Discord attachments.

Treat the volume like a secrets store. Encrypt it at rest, restrict operator
access, include it in retention planning, and never copy it into a container image
or Git repository.

Inject these values with the host's secret manager:

- `DISCORD_BOT_TOKEN`
- `TEMPORAL_API_KEY`
- `MOXN_API_KEY`
- optional `MOXN_MCP_TOKEN`

The remaining IDs and routing settings are not credentials, but keeping all
configuration together in the provider secret store is simplest.

## Updates and Temporal compatibility

The Workflow is durable code. A new image must remain replay-compatible with
executions started by an older image. For this personal baseline, stop the old
container before starting the new one and follow release notes for workflow
changes. Before production rolling deployments, adopt Temporal Worker Versioning.

Never run two gateway replicas during an update. They would both receive the same
Discord events.
