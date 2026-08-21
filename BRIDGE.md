# Authenticated operator bridge

WINCH exposes a deliberately small loopback protocol for trusted operator surfaces such as C-Plug. It is not a general remote API.

## Trust boundary

- WINCH must remain bound to loopback.
- Every bridge request requires `Authorization: Bearer <shared-secret>` and, for mutations, `X-WINCH-Request: 1`.
- The secret must contain 32 to 512 visible characters and live only in owner-restricted environment files.
- Responses contain one delegated run only. They never expose other prompts, runs, actions, or receipts.
- An authenticated caller may relay a recorded human approval for the initial proposal-mode dispatch.
- That relay can never approve a broker action. Each proposed action receives its own `W123456` code.

## Endpoints

### `GET /api/bridge/status`

Returns bridge and public harness availability. Authentication is required.

### `POST /api/bridge/runs`

```json
{
  "intent": "Ask multiple agents to review this change and reach consensus",
  "preferredHarness": null,
  "operatorApproved": true
}
```

The response contains the run, its attempts, its actions, and its events. `operatorApproved` applies only to dispatch. When omitted or false, consequential intent retains WINCH's own pending dispatch approval.

### `POST /api/bridge/approvals/W123456`

```json
{ "decision": "approve" }
```

`decision` must be `approve` or `reject`. The response is again scoped to the affected run.

## Council strategy

Intent containing “committee,” “council,” “consensus,” “multiple agents/models/harnesses,” or “all my AIs” selects the council strategy. WINCH runs one primary, up to two advisers concurrently, then supplies the bounded opinions to a distinct verifier for synthesis. Adviser and verifier outputs cannot propose executable actions; only the primary proposal is admitted to the broker.
