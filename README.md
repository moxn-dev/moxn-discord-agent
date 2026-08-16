# Moxn Discord Agent

A Discord assistant powered by Codex, Temporal Cloud, and Moxn Context OS. It
watches one private Discord channel, maintains a durable main conversation plus
independent task and fork sessions in Discord threads, understands image
attachments, and can read or write Moxn through the published Context CLI. Codex
can authenticate with either a ChatGPT subscription or an OpenAI Platform API
key.

This is an open-source personal-assistant baseline. It is intentionally not a
multi-user authorization system or hardened multi-tenant sandbox.

## Architecture

```text
Discord Gateway ──► channel registry ──► main session workflow
       │                  │              task session workflow(s)
       │                  └─────────────► fork session workflow(s)
       │                                      │
       └── Discord threads ◄──────────────────┘
                                              │
                                              ├──► Codex SDK
                                              ├──► context CLI / stdio MCP
                                              └──► persistent local state
```

Temporal Cloud stores orchestration state; it does not host the Worker or the
Discord Gateway connection. Run this process continuously on a laptop, VM, or
container host. All application connections are outbound, so the agent itself
does not need a public HTTP port.

## Features

- One allow-listed Discord guild and channel, with either one permitted user or
  all non-bot channel participants through an explicit opt-in.
- Optional explicit allow-list for trusted peer bots; the agent always rejects
  its own messages.
- No mention required in the main channel; Codex chooses whether to reply,
  react, or stay silent.
- `@alpha task <request>` starts a fresh session in a Discord thread.
- `@alpha fork <request>` starts an independent thread seeded from a bounded,
  revisioned snapshot of the main session.
- One durable Temporal workflow and resumable Codex thread per session, allowing
  different sessions to run concurrently while preserving ordering within each.
- Startup backfill for the parent channel and every registered open thread.
- Direct image input plus local-file uploads to Moxn.
- Optional live Codex web search for public research.
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
3. Install the bot with View Channel, Send Messages, Send Messages in Threads,
   Create Public Threads, Read Message History, and Add Reactions permissions.
   Do not grant Administrator.
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

To pin a model and reasoning effort instead of following Codex defaults, set for
example:

```env
CODEX_MODEL=gpt-5.6-terra
CODEX_REASONING_EFFORT=high
```

The installed Codex SDK accepts `minimal`, `low`, `medium`, `high`, or `xhigh`
reasoning effort. Model access still depends on the authenticated ChatGPT or
OpenAI Platform account.

`CODEX_SANDBOX_MODE` defaults to `workspace-write`. When the worker runs inside
Docker, set it to `danger-full-access`: Codex's Linux Bubblewrap sandbox cannot
reliably create a second namespace inside an ordinary unprivileged container.
In that mode Docker is the command boundary, so mount only the private agent data
the assistant is intended to access and never mount the Docker socket.

Web search is off by default. To let the assistant research current public
information, enable Codex's
[built-in live search](https://learn.chatgpt.com/docs/config-file/config-reference)
through this app's environment setting:

```env
CODEX_WEB_SEARCH_MODE=live
```

No separate search API key is required. `cached` is also accepted when current
results are unnecessary. Search results and fetched pages are untrusted content;
the default persona tells the assistant to use them as evidence rather than as
instructions.

Agent turns may run for up to 30 minutes. While a turn is active, the Worker
heartbeats every 10 seconds; Temporal considers it lost after 45 seconds without
a heartbeat. Container shutdown drains an in-flight turn for up to five minutes
before forcing recovery, so use the provided Compose stop grace period or give a
manual `docker stop` at least 330 seconds. The Worker accepts at most four
Activities concurrently by default; additional turns remain durably queued in
Temporal. Override this small-deployment safety limit with
`AGENT_MAX_CONCURRENT_ACTIVITIES`.

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

## Main, task, and fork sessions

Ordinary admitted messages in the configured parent channel flow to Alpha's
long-lived `main` session. Session commands must start with a direct bot mention
and contain a non-empty request:

```text
@alpha task Research the upcoming Luma event and summarize it
@alpha fork Explore the alternative we were just discussing
```

`task` starts with fresh conversational context. `fork` starts a new Codex
thread seeded from main Alpha's rolling summary and twenty most recent completed
messages, with a source revision and timestamp. The fork then diverges: later
main-channel messages are not synchronized into it. Every admitted message and
attachment posted inside the resulting Discord thread continues that session;
no mention or command prefix is required there.

Session-creation commands are recognized only in the configured parent channel.
Other Discord threads are ignored. Moxn access and memory are shared across all
sessions, so conversational isolation is not a separate authorization boundary.
Moxn rejects writes based on a stale file revision. An agent should reread and
reconcile after a conflict; agents intentionally collaborating on the same
content should use Moxn branches and pull requests.

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

The agent receives every admitted human message in the configured channel and
its registered session threads.
Direct mentions always get a response; other direct questions normally do,
while ambient notes may receive a reaction or no response. By default only
`DISCORD_ALLOWED_USER_ID` is admitted. Set `DISCORD_ALLOW_ALL_USERS=true` to use
the configured guild/channel as the boundary and admit every non-bot participant.
Set `DISCORD_ALLOWED_BOT_IDS` to a comma-separated list only when trusted peer
bots should enter the same context; never add this agent's own bot ID.
The Discord orchestrator posts the final action, so Codex never receives the
Discord bot token.

## Persistent state

`AGENT_DATA_DIR` defaults to `~/.moxn/discord-agent` and contains:

- `codex/`: isolated ChatGPT or API-key credentials and Codex sessions;
- `workspace/`: runtime `AGENTS.md` and agent scratch space;
- `workspace/sessions/`: isolated scratch directories for task and fork
  sessions;
- `inbox/`: downloaded Discord attachments.

The directory is private runtime state, not source code. Back it up carefully and
mount it on a persistent volume when deploying.

In the provided container, `/data` is only the default path *inside the
container*. Docker Compose supplies a Docker-managed named volume; it does not
assume that the host has a `/data` directory. A cloud platform may mount EBS,
EFS, or its own persistent volume at `/data`, or mount it elsewhere and set
`AGENT_DATA_DIR` to that path. The container runs as UID/GID 1000, so a custom
mount must grant that identity read/write access. Codex home and workspace paths
default beneath `AGENT_DATA_DIR`; an explicit `CODEX_HOME` or `AGENT_WORKSPACE`
overrides the corresponding default.

Temporal history contains the channel registry, Discord message text and
metadata, fork snapshots, local attachment paths, rolling summaries, and Codex
thread IDs. It does not contain service tokens or attachment bytes.

## Deployment

The reference deployment is the included Docker image on one small, always-on VM
with persistent storage. See [DEPLOYMENT.md](DEPLOYMENT.md) for Docker Compose,
Lightsail/EC2, Railway, Fly.io, and Render guidance.

Do not deploy this to request-driven serverless functions such as Vercel
Functions. The Discord Gateway and Temporal Worker require a continuously running
process with long-lived outbound connections.

## Security notes

- Run exactly one Discord Gateway replica. Its Temporal Worker can execute turns
  from independent sessions concurrently.
- Keep the Discord channel private. Retain the single-user default unless every
  participant in that channel is trusted to invoke the agent and its Moxn access.
- Allow-list peer bots sparingly. Two agents that reflexively answer each other
  can create an expensive reply loop; persona-level restraint remains important.
- The Moxn API key has the user's full intended privileges.
- Codex has outbound network access so the Context CLI can reach Moxn; optional
  web search should be enabled only when the deployment needs public research.
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

The session workflows deliberately do not retry Codex/Moxn turns: a remote write
may have succeeded before an interrupted Activity reports completion. Discord
delivery retries three times with deterministic nonces. See
[DESIGN.md](DESIGN.md) for the durability and failure model.

## License

MIT
