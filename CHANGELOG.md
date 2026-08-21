# Changelog

## 0.3.0 — 2026-08-21

- Add an authenticated loopback bridge that lets C-Plug delegate work and relay action approvals without exposing the full WINCH state.
- Accept a recorded C-Plug operator approval for the initial harness dispatch while preserving a separate approval for every proposed broker action.
- Namespace bridged approvals as `W123456` to prevent collisions with C-Plug actions.
- Add council routing with one primary, up to two parallel independent advisers, and a separate verification/synthesis pass.

## 0.2.2 — 2026-08-21

- Updated immutable GitHub Actions pins to the current Node 24-based official releases, removing the platform deprecation warning from the first protected release.

## 0.2.1 — 2026-08-21

- First public release.
- Added typed capability execution, universal connectors, workspace-scoped Codex tasks, arbitrary key-based API profiles, iMessage, Calendar, Shortcuts, file, web, application, notification, and command-recipe actions.
- Added separate human approval and receipts for every external action.
- Added owner-only private configuration, recoverable overwrites/trash, non-overwriting moves, strict loopback/Origin/Host/mutation-header checks, CSP/Trusted Types, request limits, and HTTP timeouts.
- Added provenance, public-tree leak detection, pinned CI actions, dependency auditing, and single-author repository policy.
