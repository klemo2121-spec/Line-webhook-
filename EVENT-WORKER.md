# LINE event worker

The owner cancelled the five-minute Codex automation. Do not recreate it.
The separate Node process subscribes to the existing authenticated receipt event
stream. Messages and owner clarification replies wake it immediately. Reconnecting
checks the durable queue to recover missed events; empty queues use no model or
FlowAccount calls and produce no chat messages. This worker uses no browser.

Run with the bundled Node:

- `scripts/event-expense-worker.mjs check`: read-only MCP connection, company,
  permissions, tool catalog and configured AI-model access check. This does not
  verify API credit balance or prove an actual receipt was saved.
- `scripts/event-expense-worker.mjs start`: one persistent event listener. Keep
  this computer on and connected. A process lock prevents duplicate instances.
- `scripts/event-expense-worker.mjs once`: operator recovery of the same queue,
  with the same safeguards. Never run alongside another worker.

No OS scheduled task or paid service is created. Credentials use the existing
CurrentUser DPAPI files. The AI reader preserves the existing model and reserves
at most 25 requests per Bangkok day before contacting the API, with no automatic
model-call retry or billing top-up. Extraction is cached per original image and
owner answers. Runtime and private payee rules stay in ignored `.local/`.

## Accounting

The original remains in LINE. Each verified business receipt/slip becomes one
English operating expense, with a short label, configured gross/no-input-VAT
policy and no payment. Existing month instructions are preserved. Named payees
are matched against private verified history, never an amount alone.

The model only reads facts; it cannot call accounting tools. Deterministic code
resolves a contact, previews, stores the server-built immutable plan, then asks
the protected `/api/direct-mcp` gateway to submit it. The gateway verifies the
company/permissions and live preview, stores `writing` before ONE create, and
immediately records the actual returned submission key and document identifiers.
Generic MCP calls remain read/preview-only. Payment, approval, deletion, monthly
updates, OpenAPI and attachments are not supported by this route.

Read-back of the exact record must match company, contact, date, reference,
internal marker, short line, category, amount, zero tax/discount/WHT and unpaid
status. Only verified `direct_complete` sends 👍🏻 quoting the original photo.
Missing facts use the existing short LINE questions. Replies may quote either
the original image or the bot question; they resume the same original receipt.

## Recovery

Never resubmit a `writing` expense, even after a timeout. Use its saved creation
anchor or actual returned idempotency key to read/poll. A missing status-cache
entry does not prove the document was not saved. An outcome with no anchor stays
blocked for reconciliation. `saved` only reads back/completes; `completed` only
retries the same acknowledgement. Originals expiring, ambiguous contacts,
withholding, assets/inventory, foreign currency or unsupported preview blockers
cannot silently become expenses. Review `.local/browser/event/status.json` for
the current state. Do not start old browser-worker or expense-runner processes.

Passing automated tests and a read-only preflight is not an end-to-end accounting
success. The first fresh real receipt still needs its independent saved read-back.
