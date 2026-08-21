# Universal connector protocol

WINCH's built-ins cover common personal-computer operations. The connector protocol covers everything machine- or service-specific without placing private infrastructure, credentials, or unrestricted shell execution in the public core.

A connector is a locally reviewed executable registered in the ignored `config/action-grants.json`. Its executable path, supported operation names, environment-variable names, argument template, and timeout are allowlisted. It cannot select its own executable or operation at runtime.

WINCH writes a mode-`0600` request file:

```json
{
  "protocol": 1,
  "connector": "home",
  "operation": "steam.launch",
  "input": { "game": "Elden Ring" }
}
```

The connector writes JSON or bounded text to standard output. WINCH runs it with `execFile`, a minimal environment, no shell, a bounded runtime/output, separate human approval, and a ledger receipt.

Use connectors for SSH-managed devices, home automation, browser drivers, databases, business APIs, Mail workflows, media systems, or private services. Keep each operation narrow and semantic—for example `tv.power_on` or `steam.launch`—instead of exposing `shell.run`.

The included `scripts/example-connector.mjs` implements a harmless `echo` operation. Real connectors should validate their input again, obtain secrets only from explicitly granted environment variables or the operating-system keychain, avoid returning secrets, and be tested independently.

`codex.workspace_task` is the complementary universal software capability: after approval it can run Codex with workspace-write access inside one named writable file root. It cannot leave that root through WINCH's path boundary.
