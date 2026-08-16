# Deployment guide

## Recommended shape

Run the provided Docker image as exactly one continuously running process with a
persistent volume mounted at `/data`. The service needs outbound HTTPS plus the
Discord Gateway connection, but no inbound application port.

`/data` is a logical path inside the image, not an assumed directory on the
deployment host. The application requires a private, persistent POSIX
filesystem somewhere because Codex login/session files and downloaded
attachments are file-backed. Mount the provider's durable storage at `/data`,
or mount it at another container path and set `AGENT_DATA_DIR` accordingly;
the default `CODEX_HOME` and workspace are derived beneath it. When invoking the
Codex CLI directly for login against a custom path, also set `CODEX_HOME` to the
derived `codex` directory. The image runs as the unprivileged `node` user
(UID/GID 1000). `/data` is prepared for that user; any different mount target
must be provisioned with matching ownership or read/write permissions.

For a personal deployment, a small Linux VM is the clearest default:

1. **AWS Lightsail Instance or EC2 + Docker Compose** — recommended reference
   path. It is easy to understand, gives Codex a normal persistent filesystem,
   and avoids adding managed-container storage and interactive-login complexity.
2. **Railway, Fly.io, or a Render background worker** — lower-operations options.
   Attach a persistent volume, keep one instance always running, and use the
   provider's secret store.
3. **ECS/Fargate** — viable when the operator already uses AWS container
   infrastructure, but persistent Codex state requires EFS or another durable
   mount exposed as a normal container filesystem. It is unnecessary complexity
   for one assistant.

Do not use Vercel Functions, Lambda-style request handlers, or any platform that
sleeps the process when HTTP traffic is absent. Discord Gateway and Temporal task
pollers are long-lived outbound connections.

## Docker Compose

Create `.env`, then build the image:

```bash
cp .env.example .env
docker compose build
```

The included Compose file uses the `agent-data` named volume. Docker chooses its
host location and mounts it at `/data`; no host `/data` directory is required.
For an explicit host bind mount, replace `agent-data:/data` with a narrow private
directory such as `/srv/moxn-discord-agent:/data`.

Set `CODEX_SANDBOX_MODE=danger-full-access` in `.env` for the containerized
worker. This disables Codex's nested Bubblewrap sandbox, which ordinary Docker
containers cannot initialize, and relies on the container as the outer command
boundary. Keep host bind mounts narrow, never mount the Docker socket, and do not
run the container as privileged.

Authenticate the isolated Codex home in the persistent volume. Choose exactly
one method.

### ChatGPT subscription

```bash
docker compose run --rm --entrypoint sh agent -lc \
  'mkdir -p "$CODEX_HOME" && ./node_modules/.bin/codex login --device-auth'
```

Complete the device flow using the ChatGPT account and workspace whose Codex
allowance this assistant should use.

### OpenAI API key

On the Linux host, read the key without placing it in shell history, then send it
to Codex over standard input:

```bash
read -rsp "OpenAI API key: " OPENAI_API_KEY
printf '\n'
printf '%s' "$OPENAI_API_KEY" | \
  docker compose run --rm -T \
    --entrypoint ./node_modules/.bin/codex agent login --with-api-key
unset OPENAI_API_KEY
```

Do not add `OPENAI_API_KEY` to `.env`. The login command stores the credential in
the persistent, private `CODEX_HOME`. OpenAI Platform billing applies to this
method; it does not consume included ChatGPT plan credits. See OpenAI's
[authentication guide](https://learn.chatgpt.com/docs/auth) for details.

### Verify and start

Confirm the stored authentication method and run all read-only service checks:

```bash
docker compose run --rm \
  --entrypoint ./node_modules/.bin/codex agent login status
docker compose run --rm agent \
  node --enable-source-maps dist/preflight.js
```

Start the one replica:

```bash
docker compose up -d
docker compose logs -f agent
```

Stop cleanly with `docker compose down`. Do not add `--volumes` unless you intend
to delete the Codex login, sessions, runtime workspace, and attachment inbox.

The Compose service gives the Temporal Worker 5 minutes and 30 seconds to stop.
The Worker stops polling, allows an in-flight agent turn up to five minutes to
finish, and then forces shutdown. Active turns heartbeat every 10 seconds with a
45-second Heartbeat Timeout, so a crashed or force-stopped worker is detected
without waiting for the full 30-minute turn timeout. If you run Docker without
Compose, use `docker stop --time 330 <container>` for the same drain behavior.

## AWS Lightsail Instance

Use a **Lightsail Instance** (a Linux virtual machine), not Lightsail Container
Service. This reference deployment assumes SSH access, Docker Compose, and a
host-managed persistent Docker volume. The bot exposes no HTTP service.

For this low-throughput but occasionally memory-bursty process, start with 2 GB
RAM on x86-64 Linux. A 1 GB host can work, but Codex plus the Temporal workflow
bundle has less headroom.

1. In Lightsail, [create a Linux instance](https://docs.aws.amazon.com/lightsail/latest/userguide/getting-started-with-amazon-lightsail.html)
   using an **OS Only** current Ubuntu LTS image and the 2 GB RAM plan.
2. In the instance's Networking tab, remove unneeded HTTP/HTTPS rules and
   restrict SSH to your IP address. Keep Lightsail browser SSH enabled if you use
   it. The agent needs no public application port or static IP.
3. Connect over SSH and install Docker Engine plus the Docker Compose plugin from
   [Docker's Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/).
4. Clone and configure the agent:

   ```bash
   git clone https://github.com/moxn-dev/moxn-discord-agent.git
   cd moxn-discord-agent
   cp .env.example .env
   chmod 600 .env
   nano .env
   docker compose build
   ```

5. Run either the ChatGPT subscription or API-key login above, followed by the
   authentication status and preflight commands.
6. Start the agent and inspect its logs:

   ```bash
   docker compose up -d
   docker compose logs -f agent
   ```

7. Enable Lightsail automatic snapshots and a billing alert. The Compose named
   volume lives on the instance disk, so deleting an unsnapshotted instance also
   deletes the agent's Codex credentials and local sessions.

Docker's `restart: unless-stopped` brings the process back after crashes and host
reboots. Back up the `agent-data` volume as sensitive material.

## EC2

The same Docker Compose flow works on a small Ubuntu or Debian EC2 instance.
Prefer Lightsail for this experiment unless you already need EC2 networking,
IAM, or attached-storage controls. The Compose named volume persists across
container replacement but lives on that instance's disk. For stronger instance
lifecycle independence, mount an encrypted EBS filesystem at a private host
directory and bind that directory to `/data`.

## ECS/Fargate

Mount an encrypted EFS access point into the task at `/data`. Configure the
access point's POSIX identity and root-directory ownership for UID/GID 1000 so
the image's unprivileged `node` user can write it. If a different container path
is required, set `AGENT_DATA_DIR` to it and provide the same permissions. Run one
desired task, set `CODEX_HOME=<AGENT_DATA_DIR>/codex` for direct login commands,
and inject configuration through Secrets Manager or SSM Parameter Store. Do not
use Fargate ephemeral storage for `AGENT_DATA_DIR`: replacing the task would
discard Codex authentication, resumable thread files, scratch state, and
attachments. The task needs no load balancer or inbound port.

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

- ChatGPT or OpenAI API-key credentials and Codex session logs;
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
