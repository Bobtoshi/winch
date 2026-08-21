# Security policy

WINCH is a security boundary around independent AI harnesses. Report vulnerabilities privately through GitHub private vulnerability reporting. Do not place prompts, harness outputs, credentials, local configuration, database files, or executable paths in public issues.

## Invariants

- Safe defaults enable simulations only.
- The HTTP service binds to loopback and rejects hostile Host, Origin, and cross-site mutation requests.
- Consequential intent stops before dispatch for explicit human approval.
- All bundled live harnesses run in proposal mode with no direct action tools.
- Codex runs ephemerally in an empty temporary directory with a read-only sandbox.
- Custom adapters use an absolute executable with `execFile`, never a shell.
- Custom request files and the SQLite ledger are restricted to the current user.
- Harness stdout, runtime, environment, and response shapes are bounded.
- Failed harnesses cannot silently succeed; fallback and verification are separate recorded attempts.
- Every broker action requires a separate human approval and returns a receipt.
- File access stays inside named real-path roots; writable roots are explicit.
- Web retrieval is HTTPS-only, host-allowlisted, redirect-denied, private-network-denied, size-bounded, and cannot consume email-derived links.
- iMessage recipients, calendars, applications, shortcuts, and command recipes use exact local allowlists.
- Command recipes use fixed executables and `execFile`; harness-authored shell strings are never executed.
- Universal connectors expose exact reviewed operation names rather than arbitrary executable or shell selection.
- Workspace-writing Codex tasks are confined to a named writable root and require an action approval.
- API keys are read only at execution from named environment variables; API origins, methods, and path prefixes are fixed by private grants, and keys never enter proposals or receipts.
- The optional C-Plug bridge remains loopback-only, requires an exact shared bearer secret of at least 32 characters, returns state for only the delegated run, and never treats upstream dispatch approval as approval for a proposed broker action.

## Capability grants

`config/action-grants.json` is private security configuration and is ignored by Git. Enabling a capability expands WINCH's local authority. Review proposed arguments at the Human Gate; never approve vague or unexpected targets. Keep the service on loopback and use operating-system permissions as a second boundary.

The broker intentionally omits arbitrary shell execution, permanent deletion, silent messaging, automatic link following, credential access, and approval bypasses. “Everything” means an extensible set of typed, reviewable capabilities—not unbounded ambient authority.

## Custom harness warning

`WINCH_LIVE_HARNESSES=1` plus an enabled custom configuration grants that executable the ability to run as the local user. File-mode validation does not make an untrusted binary safe. Review its source, signature, update channel, arguments, requested environment variables, network behavior, and output contract before enabling it.

WINCH does not currently sandbox arbitrary custom binaries. Use an operating-system sandbox or virtual machine when the adapter is not fully trusted.
