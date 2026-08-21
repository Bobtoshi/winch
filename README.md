# WINCH

**One command. Every harness. One human boundary.**

WINCH is a local control plane for AI harnesses. It classifies an operator's intent, ranks compatible harnesses, preserves fallbacks, attaches an independent verifier, converts proposals into typed actions, and executes only the actions a human explicitly approves.

The name comes from the machine: one controlled point coordinating several lines under load. The name has not received formal trademark clearance.

## Architecture

```text
operator intent
      ↓
policy gate → capability classification → ranked harness route
                                            ↓
                             primary + fallback + verifier
                                            ↓
                              normalized action proposals
                                            ↓
                             validate → approve → execute
                                            ↓
                                      local receipts
```

WINCH includes:

- simulated, Codex CLI, and custom CLI harness adapters;
- deterministic routing across capability, availability, priority, reliability, and cost;
- independent fallback and verification routes;
- a local SQLite receipt ledger;
- a loopback-only web UI with Host, Origin, CSP, framing, and body-size controls;
- typed actions for scoped files, HTTPS retrieval, arbitrary granted APIs, macOS notifications and apps, Apple Shortcuts, Calendar, iMessage, predeclared command recipes, workspace-writing Codex tasks, and reviewed local connectors;
- separate human approval for harness dispatch and every external action;
- recoverable trash rather than permanent file deletion;
- exact allowlists for roots, hosts, apps, shortcuts, calendars, recipients, and commands.

Harnesses never receive raw operating-system authority. They return proposals using protocol v2. The broker validates the type and target, waits for approval, executes using bounded native APIs or `execFile` without a shell, and records the receipt.

## Start safely

WINCH requires macOS and Node.js 22.5 or newer.

```bash
npm start
```

Open `http://127.0.0.1:4321`.

The default mode uses four clearly labelled simulations and locks every real action. Nothing is sent to an external model and no external system changes.

```bash
npm test
```

## Enable Codex

Copy `.env.example` to the ignored `.env`, then deliberately enable live adapters and Codex:

```dotenv
WINCH_LIVE_HARNESSES=1
WINCH_CODEX_ENABLED=1
```

Protect the private environment file before starting WINCH:

```bash
chmod 600 .env
```

WINCH uses the already-authenticated `codex` executable in ephemeral, read-only proposal mode. Intent may leave the machine according to that provider's configuration and terms. Codex sees the public action catalog but receives no execution authority.

## Grant real actions

Copy `config/action-grants.example.json` to the ignored `config/action-grants.json`. Grant only roots, hosts, applications, shortcuts, calendars, iMessage recipients, and fixed command recipes you have reviewed. Then enable the broker locally:

```bash
chmod 600 config/action-grants.json
```

```dotenv
WINCH_ACTIONS_ENABLED=1
```

Every action still stops in the Human Gate. An enabled capability is permission to offer it for approval, not permission to run automatically.

`command.run` accepts only named recipes with fixed executables and argument templates. WINCH never passes a harness-authored command string to a shell.

`web.fetch` accepts only allowlisted, credential-free HTTPS hosts, rejects private network targets and redirects, and never fetches a URL marked as originating from email. WINCH has no email-link opener.

For iMessage, add exact recipients to `imessageRecipients`, enable `imessage.send`, and approve the macOS Messages automation prompt when macOS asks. Each message requires a fresh WINCH approval.

For capabilities beyond the built-ins, enable `connector.invoke` and register narrow operations using `CONNECTORS.md`. A connector can wrap SSH, home devices, Mail, a browser driver, databases, APIs, or any private service. `codex.workspace_task` can build and modify software inside an explicitly writable root after approval. These two capabilities are the universal extension boundary; private machine authority stays in the ignored grants file rather than the public core.

For any key-based HTTP API, add a named profile under `apis` and enable `api.request`. The profile accepts any environment-variable name and either `Authorization` or a custom header such as `x-api-key`, while fixing the HTTPS origin, methods, and path prefixes. Only the profile name and proposed request appear in receipts; the key and private profile never do.

## Register another harness

Copy `config/harnesses.example.json` to the ignored `config/harnesses.json`. Use an absolute executable path, leave the adapter disabled until reviewed, and expose only environment-variable names it needs.

```bash
chmod 600 config/harnesses.json
```

WINCH launches adapters with `execFile`, never a shell. The executable must be a regular executable file and cannot be world-writable. It receives a mode-`0600` request file:

```json
{
  "protocol": 2,
  "mode": "propose_actions",
  "intent": "Compare the approaches",
  "actionCatalog": [],
  "context": {}
}
```

The adapter writes one JSON object to standard output:

```json
{
  "summary": "Comparison complete",
  "result": "Concise operator-facing result",
  "proposed_actions": [
    {
      "type": "web.fetch",
      "title": "Read the approved source",
      "risk": "approval",
      "arguments": {
        "url": "https://example.com/report",
        "source": "operator"
      }
    }
  ]
}
```

Unknown fields are removed. Output, duration, arguments, environment, and proposal counts are bounded.

## Authorship and public release

WINCH is authored and maintained by **Bobtoshi**. `AUTHORS.md`, `NOTICE`, `CITATION.cff`, `REUSE.toml`, package metadata, CODEOWNERS, and the initial Git history carry the canonical provenance record. The initial contribution policy accepts reports and discussion but not third-party code, keeping the canonical tree single-author.

Before publishing:

```bash
npm ci
npm test
npm run check:public
```

The public-tree check fails on private grant files, environment files, obvious credentials, and local user paths. Never commit `config/action-grants.json`, `config/harnesses.json`, `.env`, `data/`, browser traces, or generated output.

Read `SECURITY.md` and `PRIVACY.md` before enabling live capabilities. WINCH is licensed under the GNU Affero General Public License v3.0 only. Copyright and attribution are recorded in `NOTICE`; authorship is explained in `AUTHORS.md`.
