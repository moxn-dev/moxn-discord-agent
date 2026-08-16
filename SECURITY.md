# Security

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Report it to
the repository maintainers through GitHub's private vulnerability reporting
feature.

## Operating assumptions

This agent is intentionally powerful. It grants one configured Discord user the
Moxn permissions associated with `MOXN_API_KEY`, and it sends channel content and
attachments to Codex. Run one instance, use a private Discord channel, restrict
the bot's channel permissions, keep all credentials in a secret manager or
untracked `.env`, and mount `AGENT_DATA_DIR` on encrypted persistent storage.

The Codex sandbox has outbound network access because the Context CLI requires
it. Treat Discord and Moxn content as untrusted, review `agent/AGENTS.md`, and do
not use this baseline as a multi-tenant authorization boundary.

Task and fork threads inherit the configured parent channel's Discord access.
A fork copies a bounded snapshot of main-channel conversation into its Temporal
history, and every session uses the same privileged Moxn identity. Do not add
people to a session thread who should not receive that parent-channel context or
exercise that Moxn authority. Concurrent sessions can also edit the same Moxn
document; use narrow tasks and review conflicts when experimenting with parallel
writes. Moxn rejects stale-revision writes; reread and reconcile a conflict, or
use branches and pull requests when multiple agents intentionally collaborate on
the same content.
