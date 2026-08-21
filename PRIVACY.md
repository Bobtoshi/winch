# Privacy

WINCH stores operator intent, routing decisions, normalized harness outputs, proposed action arguments, approvals, action receipts, and execution events in a local SQLite ledger. The data directory and database files are restricted to the current user, and runs are pruned after 30 days by default.

Simulation mode makes no external model request.

When a live harness is enabled, the operator intent and bounded verification context are given to that local executable. The executable may send them to its configured provider. WINCH does not hide that boundary: each registry entry is labelled `ready`, `locked`, `unavailable`, or `simulation`.

Custom adapters receive only:

- protocol version and `propose_actions` mode;
- the current operator intent;
- the public action catalog, but not the private target allowlists;
- up to 8,000 characters of a primary result when acting as verifier;
- environment variables explicitly named in local configuration.

WINCH contains no telemetry or remote collector. It does not copy provider credentials, API keys, or the private grants document into SQLite, logs, browser state, harness prompts, or receipts. Action and API results can contain sensitive content, so the ledger should be treated as private operator data.
