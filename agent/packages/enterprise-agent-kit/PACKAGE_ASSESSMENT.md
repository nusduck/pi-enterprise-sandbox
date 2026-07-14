# Package reuse assessment

The package adapts Pi's official Todo, Question, custom-compaction, protected-path,
and structured-output patterns. No third-party runtime Extension is installed.

The MCP adapter is internal because the Web/RPC runtime requires host-owned tenant
identity, credential references, allowlists, durable approval, persistent audit,
result redaction, and strict separation from the Conversation Sandbox. Candidate
local/TUI adapters did not meet those boundaries without bypassing the platform
host. Re-evaluation must record an exact version and commit, source review,
dependency review, SBOM update, and Extension allowlist change in `governance.json`.

Runtime installation and automatic upgrades are prohibited. The production image
installs the local package with `npm ci` from the committed lockfile.
