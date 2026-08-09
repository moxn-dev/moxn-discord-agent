# Design decisions

## Why the process is local and long-running

Temporal owns durable orchestration, not network ingress or compute. A Temporal
Workflow is stored state plus deterministic decisions; an available Worker still
has to execute Activities. Discord's bot interface also uses an outbound Gateway
WebSocket that a local process must keep open. Temporal Cloud cannot initiate or
host that socket.

Keeping both roles in one Node process is the smallest design. It requires no
public application port: Discord, Temporal Cloud, Codex, and Moxn connections
are all outbound. Moving from a laptop to a small VM or container changes the
process location, not the workflow architecture.

## State ownership

| State | Owner | Reason |
| --- | --- | --- |
| Message text/metadata, queue, checkpoint | Temporal Workflow | Replay and crash recovery |
| Rolling summary and Codex thread ID | Temporal Workflow | Resume one channel-level conversation |
| Photo/file bytes | Private persistent inbox | Keep large payloads out of workflow history |
| Codex login and session files | Isolated persistent `CODEX_HOME` | Resume Codex threads across restarts |
| Persona | Checked-in `agent/AGENTS.md`, copied locally | User-controlled and reviewable |
| Moxn documents/media | Moxn | Durable context and full read/write capability |

Discord itself is the offline ingress buffer. On reconnect, the gateway asks for
messages after the workflow checkpoint and applies the same authorization guard
before signaling them.

## Turn semantics

The workflow waits briefly to coalesce adjacent messages, drains the queue, and
runs one Codex Activity. New messages arriving during that Activity remain queued
for the next turn. The Activity receives recent raw channel context, a rolling
summary, new attachments, and the persisted Codex thread.

Codex produces structured output with `reply`, `react`, or `silent`. Discord
delivery is a separate Activity. Moxn access defaults to the published Context
CLI, which supports local file uploads. The published stdio MCP server is an
optional second surface. There is no HTTP MCP bridge and no base64 media.

## Failure policy

Codex/Moxn turns are not automatically retried. A process failure can occur after
a remote write but before the Activity reports success, so blind retries could
duplicate a CRM update. Discord delivery is retried three times with deterministic
nonces. After 100 turns the workflow continues as new to keep history bounded
while carrying forward its summary, recent context, checkpoint, and thread ID.

The next hardening step would be explicit idempotency keys for every Moxn mutation;
then selected agent failures could be retried safely.

## Deployment constraints

- Run exactly one replica. Multiple Discord Gateway consumers would receive the
  same events even though Temporal deduplicates already-recorded messages.
- Persist `AGENT_DATA_DIR`. It contains the Codex login credential, resumable
  session data, the runtime persona, and downloaded attachments.
- Do not use request-driven functions that sleep between HTTP requests. The
  Discord Gateway and Temporal Worker both hold long-lived outbound connections.
- Workflow code changes must remain replay-compatible. Production operators
  should adopt Temporal Worker Versioning before doing rolling upgrades.

## Security boundary

Ingress is restricted by guild, channel, user, and non-bot author checks before
attachments are downloaded. Codex runs in a private workspace without access to
an application repository. It does receive the configured Moxn API key and has
outbound network access so the Context CLI can operate. Discord messages, Moxn
content, and attachments are therefore untrusted inputs to a privileged agent;
this project is a useful personal-assistant baseline, not a hardened multi-tenant
sandbox.
