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
