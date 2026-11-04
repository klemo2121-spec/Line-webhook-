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
- `scripts/event-expense-worker.mjs connect`: sends one fresh official OAuth
  authorization link to the configured owner's expense LINE group. This requires
  exactly one allowed group and owner; no credentials or approval are invented.
- `scripts/event-expense-worker.mjs once`: operator recovery of the same queue,
  with the same safeguards. Never run alongside another worker.

No OS scheduled task or paid service is created. Credentials use the existing
CurrentUser DPAPI files. The AI reader preserves the existing model and reserves
at most 25 requests per Bangkok day before contacting the API, with no automatic
model-call retry or billing top-up. Extraction is cached per original image and
owner answers. Runtime and private payee rules stay in ignored `.local/`.
The reader persists its attempt before the model call. An incomplete response or
crash cannot charge for that same reading again on the next wake. Genuine job
blockers emit one short quoted notice in the source group, without claiming the
document was or was not saved; the existing financial state remains unchanged.
If the standalone OAuth connection is missing, the listener waits without reading
images or creating expenses. A successful verified OAuth callback publishes a
connection event so queued work can resume after the owner authorizes FlowAccount.

## Accounting

The owner approved product-first list headings for FUTURE expenses. When private
config expenseHeading=product, the short English expense label is also the
document contact label (for example CO2 supply or Fertilizers). The original
recipient stays in the immutable source receipt and a Payee: entry in internal
notes, independently checked on saved read-back. Resolve product-label contacts
separately; do not reuse or rename a real payee contact for that label. Existing
plans/documents keep their previous format and financial state.

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
Owner captions quoting an image are captured while it is queued or being read,
before any question. The processor refreshes the latest caption after reading;
version guards prevent stale questions or plans when another caption arrives.
Reader-v2 image facts are reused after captions change, without another AI call.
Resending the same untouched image that was parked for clarification resumes
that same job once, associates captions with the new photo and quotes it on
completion. Planned/writing/completed duplicates never resume financial writes.
Short coordinator contention retries only lock acquisition, never an operation.
Receipt intake failures return HTTP503 for LINE redelivery instead of sending
a generic chat error and falsely acknowledging successful intake.
Bank-app screenshots are payment slips. A model classification of `other` parks
the original and asks one document question; it cannot silently reject an image.
The image reader receives no payroll/payee history or owner answers. It reads
sender and recipient separately. For bank slips, code uses only the recipient,
clears model-inferred purpose/category and applies private history afterward.
The server rejects contradictory party fields before any plan. A familiar sender
cannot become the expense recipient or trigger a salary/purpose classification.
Where private history includes a verified contact source, the gateway re-reads
that exact expense and checks company, record id, recipient name and contact id.
It reuses that supplier without relying on the contact search index. This uses
no historical amount, date or payment status for the new expense.

## Recovery

Never resubmit a `writing` expense, even after a timeout. Use its saved creation
anchor or actual returned idempotency key to read/poll. A missing status-cache
entry does not prove the document was not saved. An outcome with no anchor stays
blocked for reconciliation. `saved` only reads back/completes; `completed` only
retries the same acknowledgement. Originals expiring, ambiguous contacts,
withholding, assets/inventory, foreign currency or unsupported preview blockers
cannot silently become expenses. Review `.local/browser/event/status.json` for
the current state. Do not start old browser-worker or expense-runner processes.

An operator can use `direct-expense-worker.mjs review-rejected FILE` to read an
untouched rejected individual original. After visually reviewing that exact
image, `recover-rejected FILE` requires its id, matching imageHash and
originalReviewed:true. It restores the same job once and records the review;
it cannot recover a job with a financial plan or replay a financial write.

Passing automated tests and a read-only preflight is not an end-to-end accounting
success. The first fresh real receipt still needs its independent saved read-back.
