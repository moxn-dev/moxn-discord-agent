# Moxn Discord Agent

A Discord assistant powered by Codex, Temporal Cloud, and Moxn Context OS. It
watches one private Discord channel, maintains one durable
channel-level conversation, understands image attachments, and can read or write
Moxn through the published Context CLI. Codex can authenticate with either a
ChatGPT subscription or an OpenAI Platform API key.

This is an open-source personal-assistant baseline. It is intentionally not a
multi-user authorization system or hardened multi-tenant sandbox.

## Architecture

```text
Discord Gateway ──► Node worker ──► Temporal Cloud
                       │             durable queue, checkpoint,
                       │             summary, and Codex thread ID
                       │
                       ├──► Codex SDK ──► ChatGPT subscription or OpenAI API
                       │        │
                       │        ├──► context CLI ──► Moxn
                       │        └──► optional stdio Moxn MCP
                       │
                       └──► persistent attachment inbox + Codex state
```

Temporal Cloud stores orchestration state; it does not host the Worker or the
Discord Gateway connection. Run this process continuously on a laptop, VM, or
container host. All application connections are outbound, so the agent itself
does not need a public HTTP port.

## Features

- One allow-listed Discord guild and channel, with either one permitted user or
  all non-bot channel participants through an explicit opt-in.
- No mention required; Codex chooses whether to reply, react, or stay silent.
- One durable channel workflow and one resumable Codex thread.
- Startup backfill for messages received while the process was offline.
- Direct image input plus local-file uploads to Moxn.
- Context CLI installed as a pinned npm dependency; no global install required.
- Optional published stdio MCP server—no HTTP MCP bridge.
- Structured replies, typing status, Discord message splitting, and retry-safe
  delivery nonces.

## Requirements

- Node.js 20 or newer.
- Either a ChatGPT plan with Codex access or an OpenAI Platform account with API
  billing enabled.
- A Discord application installed in a private server.
- A Temporal Cloud namespace and API key.
- A Moxn workspace and API key.

## Quick start

### 1. Configure Discord

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. Create an application and bot.
2. Enable the **Message Content Intent**.
3. Install the bot with View Channel, Send Messages, Read Message History, and
   Add Reactions permissions. Do not grant Administrator.
4. Enable Discord Developer Mode and copy the server, channel, and permitted user
   IDs.

Restrict the bot to the configured channel in Discord as a second security layer.

### 2. Configure the environment

```bash
cp .env.example .env
```

Fill the required values. `TEMPORAL_TASK_QUEUE` is an application-defined routing
name; it does not need to be created in the Temporal UI.

`.env` is ignored by both Git and Docker. For a deployment, prefer the host's
secret manager or an external environment file.

### 3. Install and authenticate Codex

```bash
npm ci
export CODEX_HOME="$HOME/.moxn/discord-agent/codex"
mkdir -p "$CODEX_HOME"
```

Choose one login method.

**ChatGPT subscription:**

```bash
./node_modules/.bin/codex login --device-auth
```

**OpenAI API key:** set `OPENAI_API_KEY` without putting it in shell history,
then pipe it into the one-time login command:

```bash
printf '%s' "$OPENAI_API_KEY" | \
  ./node_modules/.bin/codex login --with-api-key
unset OPENAI_API_KEY
```

API-key usage is billed through the OpenAI Platform account rather than using
included ChatGPT plan credits. See OpenAI's
[authentication guide](https://learn.chatgpt.com/docs/auth) for the distinction.
Confirm the selected method with:

```bash
./node_modules/.bin/codex login status
```

The isolated `CODEX_HOME` must live on persistent storage. It contains the
login credential and resumable Codex session state; never commit or bake it into
an image. Do not add `OPENAI_API_KEY` to this project's `.env`; the running agent
uses the protected Codex login store.

### 4. Verify and run

```bash
npm run preflight
npm run dev
```

`preflight` checks Codex authentication and performs read-only Discord, Temporal
Cloud, and Moxn CLI connection checks. `dev` builds and starts the Worker. On
later runs, use `npm start` after building.

The first launch checkpoints the newest existing Discord message rather than
replaying the entire channel. Send a fresh message to begin.

## Moxn tools and attachments

The pinned `context` CLI is the portable default and authenticates through
`MOXN_API_KEY`. It supports reads, writes, and local file uploads.

For a Discord photo, Codex receives both a vision input and a private local path.
It can create a first-class file with:

```bash
context files upload --file /path/to/photo.jpg --path /photos/photo.jpg
```

It can also run `context upload`, then place the returned storage key into a
markdown-backed Moxn document.

To additionally expose Moxn's published stdio MCP server, set:

```env
MOXN_MCP_ENABLED=true
```

The MCP server uses stored renewable OAuth credentials by default. An explicit
`MOXN_MCP_TOKEN` must be an OAuth bearer token, not a Moxn API key.

## Moxn as agent memory

Moxn is the assistant's durable memory layer, not just an external search tool.
The agent can use the Context CLI to recall prior information and to create,
update, organize, and archive memory on its own initiative. Durable facts,
decisions, rationale, relationships, preferences, dates, and follow-ups can live
beyond one Codex thread or Temporal summary.

The memory structure is intentionally agent-maintained. The agent may evolve the
folder and file layout, naming conventions, indexes, tag taxonomy, properties,
metadata, and summary strategy as usage reveals a better approach. Its default
persona instructs it to search before creating duplicates, preserve provenance,
make broad reorganizations in recoverable steps, and verify that substantive
content survives. Operators can narrow or replace this authority in their custom
`AGENTS.md` persona.

## Persona and channel behavior

Edit [agent/AGENTS.md](agent/AGENTS.md) to change the assistant's voice, attention
policy, and Moxn workflow. Startup copies it into the private runtime workspace.
Restart after changing the file.

The agent receives every admitted human message in the configured channel.
Direct mentions always get a response; other direct questions normally do,
while ambient notes may receive a reaction or no response. By default only
`DISCORD_ALLOWED_USER_ID` is admitted. Set `DISCORD_ALLOW_ALL_USERS=true` to use
the configured guild/channel as the boundary and admit every non-bot participant.
The Discord orchestrator posts the final action, so Codex never receives the
Discord bot token.

## Persistent state

`AGENT_DATA_DIR` defaults to `~/.moxn/discord-agent` and contains:

- `codex/`: isolated ChatGPT or API-key credentials and Codex sessions;
- `workspace/`: runtime `AGENTS.md` and agent scratch space;
- `inbox/`: downloaded Discord attachments.

The directory is private runtime state, not source code. Back it up carefully and
mount it on a persistent volume when deploying.

Temporal history contains Discord message text and metadata, local attachment
paths, the rolling summary, and the Codex thread ID. It does not contain service
tokens or attachment bytes.

## Deployment

The reference deployment is the included Docker image on one small, always-on VM
with persistent storage. See [DEPLOYMENT.md](DEPLOYMENT.md) for Docker Compose,
Lightsail/EC2, Railway, Fly.io, and Render guidance.

Do not deploy this to request-driven serverless functions such as Vercel
Functions. The Discord Gateway and Temporal Worker require a continuously running
process with long-lived outbound connections.

## Security notes

- Run exactly one replica.
- Keep the Discord channel private. Retain the single-user default unless every
  participant in that channel is trusted to invoke the agent and its Moxn access.
- The Moxn API key has the user's full intended privileges.
- Codex has outbound network access so the Context CLI can reach Moxn.
- Message and file content can contain prompt injection. This is not a security
  boundary for mutually untrusted users.
- Never commit `.env`, the agent data directory, Codex credentials, or downloaded
  attachments.

Read [SECURITY.md](SECURITY.md) before exposing the bot to real data.

## Development

```bash
npm run check
npm audit
npm run secrets:scan -- --history
docker build -t moxn-discord-agent .
```

The workflow deliberately does not retry Codex/Moxn turns: a remote write may
have succeeded before an interrupted Activity reports completion. Discord
delivery retries three times with deterministic nonces. See [DESIGN.md](DESIGN.md)
for the durability and failure model.

## License

MIT
