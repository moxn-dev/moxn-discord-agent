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
| Parent checkpoint and Discord thread/session map | Temporal registry Workflow | Durable routing and crash reconciliation |
| Session messages, queue, checkpoint, summary, Codex thread ID | Temporal session Workflow | Independent replay, ordering, and recovery |
| Fork source revision, timestamp, summary, and recent messages | Fork session Workflow | Inspectable application-level branch context |
| Photo/file bytes | Private persistent inbox | Keep large payloads out of workflow history |
| Codex login and session files | Isolated persistent `CODEX_HOME` | Resume Codex threads across restarts |
| Persona | Checked-in `agent/AGENTS.md`, copied locally | User-controlled and reviewable |
| Moxn documents/media | Moxn | Durable context and full read/write capability |

Discord itself is the offline ingress buffer. On reconnect, the gateway asks for
parent-channel messages after the registry checkpoint and thread messages after
each session checkpoint, applying the same authorization guard before signaling
them.

## Session registry and routing

The configured parent channel has one long-lived `main` session. An exact
`@alpha task <request>` command creates a Discord thread and a fresh session;
`@alpha fork <request>` creates a thread and a new session seeded from the last
completed main-session snapshot. A public thread created from a Discord message
uses the starter message ID as its thread ID, giving the gateway a deterministic
session key before all persistence steps complete.

The gateway starts or signals the independent session Workflow before recording
the registry entry and advancing the parent checkpoint. If the process fails
between those operations, startup backfill sees the same root message, finds the
same Discord thread, and safely signals the same Workflow. Session Workflows
deduplicate Discord message IDs.

The registry is a control plane, not a conversation owner. Session Workflows are
independent rather than children of the registry, so they can run concurrently,
continue as new independently, and outlive any one registry run.

## Turn semantics

Each session workflow waits briefly to coalesce adjacent messages, drains its
queue, and runs one Codex Activity. New messages arriving in that session during
the Activity remain queued for its next turn; other session Workflows may run at
the same time. The Activity receives recent raw session context, a rolling
summary, new attachments, and the persisted Codex thread.

The Codex SDK starts or resumes threads but does not expose a clone operation.
Consequently a fork is a fresh Codex thread seeded with an application-owned,
token-bounded copy of main state: rolling summary, twenty recent completed
messages, source revision, and timestamp. It does not share main's Codex thread
ID and does not receive future main conversation automatically. Moxn remains a
shared durable knowledge and mutation surface across all sessions.

Codex produces structured output with `reply`, `react`, or `silent`. Discord
delivery is a separate Activity. Moxn access defaults to the published Context
CLI, which supports local file uploads. The published stdio MCP server is an
optional second surface. There is no HTTP MCP bridge and no base64 media.

The Worker caps concurrent Activities at four by default. This deliberately
keeps overload in Temporal's durable task queue instead of allowing the SDK's
much larger development default to spawn many simultaneous Codex processes.
Because Codex processing and brief Discord delivery share the same pool, a
delivery may wait for a slot under full load; that is an acceptable POC tradeoff.

## Failure policy

Codex/Moxn turns are not automatically retried. A process failure can occur after
a remote write but before the Activity reports success, so blind retries could
duplicate a CRM update. Discord delivery is retried three times with deterministic
nonces. Exhausted Discord delivery retries are logged without terminating the
durable session. After 100 turns each session workflow continues as new to keep
history bounded while carrying forward its summary, recent context, checkpoint,
and thread ID.

Moxn itself performs optimistic concurrency control: a write based on a stale
file revision is rejected. The agent must reread and reconcile rather than
blindly overwriting. Parallel agents intentionally changing the same content
should isolate work with Moxn branches and pull requests.

The next hardening step would be explicit idempotency keys for every Moxn mutation;
then selected agent failures could be retried safely.

## Deployment constraints

- Run exactly one Gateway replica. Multiple Discord Gateway consumers would
  receive the same events even though Temporal deduplicates already-recorded
  messages.
- Independent Temporal session Workflows and their Codex Activities may execute
  concurrently in that replica. Each non-main session receives its own local
  scratch directory, but Moxn is shared and conflicting remote edits remain an
  application-level concern.
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
