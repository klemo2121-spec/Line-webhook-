# LINE translator, cashier and monthly expense bot

Existing translation, cashier checks and reminders remain in `api/webhook.js`.
Set `LEGACY_BOTS_ENABLED=false` on the expense project to keep the previously
disabled translator, cashier and scheduled reminders off.
Legacy bots also stay off when that variable is absent; they require an explicit
`true` so a new preview branch cannot accidentally reactivate them.

The optional receipt feature adds monthly expense documents in FlowAccount,
with one line per receipt and the original image attached. It is disabled by default.

## Local browser path without OpenAPI

`BROWSER_WORKER_ENABLED=true` switches the allowlisted expense group to an
encrypted durable queue, exclusively bypassing the OpenAPI handler. A local
Codex browser workflow claims jobs using a Windows DPAPI-protected token. See
`BROWSER-WORKER.md` for setup, exact UI procedure and recovery rules.

This path needs the computer, Codex app, Chrome extension and FlowAccount login
available. It is not a standalone background browser daemon. It is disabled by
default and must pass a live attachment/save/reopen test before unattended runs
are enabled. A successful mock test or a connected MCP account is not that test.
Queued month instructions work; changes after processing has started currently
require reconciliation rather than automatically moving saved expense lines.
Unknown writes block retries, bank slips never create expense lines/payments,
and the only success reply is a quoted thumb after saved-document and original
attachment verification. No OpenAPI plan upgrade is required by this path.

Normal image attachment remains the default. A lossless monthly ZIP is permitted
ONLY after FlowAccount explicitly rejects another image because of its image or
attachment count limit. It is never generated routinely or for network/browser
permission errors. The local CLI includes all original images in that exact
monthly document plus the incoming original, with a manifest and SHA-256 checks.
Success requires downloading the saved ZIP and verifying every member. It never
deletes existing attachments; a total file limit that also rejects ZIP blocks the
job. ZIP-at-limit acceptance has not yet been live-tested.

## MCP OAuth connection (no OpenAPI client credentials)

The bot can establish its own persistent OAuth connection to the official
`https://mcp.flowaccount.com/mcp` server. This is separate from a FlowAccount
connection in ChatGPT and from a temporary capability-probe session.

This milestone provides **connection, reads and previews only**. It does not
enable expense creation, payment recording, image uploads or monthly updates.
The official MCP catalog observed on 2026-11-03 exposed no attachment upload or
expense update tool. Consequently the complete monthly receipt workflow still
needs a supported attachment/update implementation before writes are enabled.
The existing monthly handler below continues to use OpenAPI; merely enabling
MCP connections does not switch that handler's backend or make OpenAPI free.

To configure the connection without activating legacy bots or accounting writes:

1. Set a **private** expense Redis URL/token, `LINE_CHANNEL_SECRET`, exact
   `EXPENSE_GROUP_IDS` / `EXPENSE_USER_IDS`, and `FLOWACCOUNT_COMPANY_ID`.
2. Set `APP_BASE_URL` to the deployment's canonical HTTPS origin (no path or
   trailing slash). Set `FLOWACCOUNT_OAUTH_ENCRYPTION_KEY` to 32 random bytes
   encoded as base64, stored only in server-side secret settings. Loss or rotation
   of this key requires users to reconnect.
3. Deploy the callback at `/api/flowaccount-callback`, then set
   `MCP_CONNECTIONS_ENABLED=true`. Keep `LEGACY_BOTS_ENABLED=false`,
   `RECEIPTS_ENABLED=false` and `FLOWACCOUNT_WRITE_ENABLED=false`.
4. An allowlisted user in an allowlisted LINE group sends `flow connect`.
   The bot returns an OAuth link valid for ten minutes. The user selects the
   intended company and authorizes it in FlowAccount. Treat this link as personal;
   group members must not forward it. A different-company selection is refused.
5. Back in LINE, `flow status` verifies live access and reports the connected
   company. A successful callback alone never acknowledges an expense.

OAuth state and tokens are AES-256-GCM encrypted in private Redis. State is
single-use and expires after ten minutes. Tokens are scoped to the initiating
LINE user and group. Refreshes use a shared lock and preserve rotated refresh
tokens. Only the fixed official OAuth and MCP origins receive credentials.
The callback uses the configured origin, never an inbound Host header, and
returns no tokens or authorization codes. No client secret is required.

The MCP transport accepts JSON and SSE responses. Its explicit tool allowlist
allows company/expense reads and expense previews with `confirm=false` only;
confirmed creates, payments and all unlisted tools fail before network I/O.

`npm test` covers OAuth PKCE, encrypted storage, state replay/expiry, issuer and
company checks, refresh locking, SSE, payment/write rejection, LINE allowlists,
callback secret redaction and signature checks in MCP-only mode. These tests
mock the provider; the deployed LINE OAuth flow still requires live verification.

## Chat workflow

- Send one JPEG/PNG receipt per message in an authorized expense group.
- Default accounting month is the **receipt date**, not the upload date.
- The bot groups receipts under Petty cash box, Online shopping, or Electricity.
  An unclear category/group is held for review rather than guessed.
- After saving the monthly line **and attaching that exact image**, the bot sends
  only `👍🏻`, quoting the original image using LINE's `quoteToken`.
  This is a separate quoted reply, not a LINE reaction (no documented reaction endpoint).
- Bank transfer slips are attachment-only evidence: no new expense or payment is
  inferred from a slip. Specify its group/month if not clear.
- `צרף את זה לחודש שעבר` / `attach to last month`: adjust your last receipt.
- Reply/quote a specific image with that instruction to select that receipt instead.
- `צרף את הקבלה הבאה לחודש שעבר`: applies to your next image in this group for
  one hour, then is consumed. Another user's image does not consume it.
- `צרף לחודש 2026-10`, `צרף לאוקטובר 2025`, or `הוסף לקניות אונליין` work too.
- Relative months use Asia/Bangkok and handle year rollover. Named months without
  a year mean the most recent occurrence (November -> December means prior December).
- `expense status`: last receipt status; `expense sync`: retry a known safe sync or
  pending attachment; `expense help`: instructions.

Changing the accounting month never changes the date printed in the receipt's
line description. The original images are retained in private Redis for seven days
for attachment retries and month corrections. FlowAccount attachments remain there.

## Recording policy and existing monthly documents

The inspected existing workflow records gross expense amounts without claiming
input VAT and groups lines in monthly documents. Set
`FLOWACCOUNT_RECORDING_POLICY=gross_no_input_vat` explicitly to use that policy.
This describes how the expense is recorded; it does not assert that the supplier
receipt itself has no VAT. Nonzero withholding, inventory, fixed assets, unclear
business purpose, unreadable totals/dates and unsupported currency require review.

New documents stay awaiting/unpaid; the bot does not approve documents, record
payments, deduct money from the cashier drawer, reopen paid months, or undo payments.

The bot discovers existing monthly documents by month and recognizable contact
name. Use `FLOWACCOUNT_MONTHLY_DOCUMENTS_JSON` to bind a specific existing ID when
names are ambiguous. Paid/approved documents are held for manual review with no
replacement document created. Legacy/manual drafts are also held for review.
Only drafts created by this integration with its reference and unmodified lines
can be rewritten automatically. This prevents dropping existing entries or payment data.

A month correction updates the source and target drafts under a shared writer
lock. A sole receipt can relocate its existing bot draft into an empty destination.
Moving the final line into an already existing destination requires manual
correction: the bot does not silently delete/void the empty source document.
Already attached images are not removed from the old document during corrections.

## Server configuration

Use Node.js 22 or newer. Set the variables in `.env.example` in the hosting
provider's secret/environment settings, never in source control or chat.

Before deploying even with receipts disabled, configure the cashier Redis and cron
variables below; source no longer has hardcoded fallback credentials.

1. Obtain company-scoped FlowAccount OpenAPI credentials. A ChatGPT FlowAccount
   connection does not provide persistent credentials to this Vercel application.
   Confirm the matching API and token URLs for sandbox/production with FlowAccount.
2. Set the expected `FLOWACCOUNT_COMPANY_ID`; the app checks `/company/info`
   before any expense write or attachment. Do not put private company IDs in this public repo.
3. Read `/expenses/categories/business` for that company. For each supported category,
   configure a named template in `FLOWACCOUNT_EXPENSE_CATEGORIES_JSON` containing:
   `systemCode`, `categoryId`, `nameLocal`, `nameForeign`, `creditId`, `creditCode`,
   `creditCategory`, `creditNameLocal`, `creditNameForeign`, `debitId`, `debitCode`,
   `debitCategory`, `debitNameLocal`, `debitNameForeign`.
   Use real company values, not API documentation examples. Templates are checked
   against the live categories before writes.
4. Use a **new private Redis database/token** for the receipt feature. The legacy
   cashier history contains previously committed credentials. This change removes
   them from the active source but not Git history: rotate them and set
   `CASHIER_UPSTASH_REDIS_REST_URL`, `CASHIER_UPSTASH_REDIS_REST_TOKEN`, and
   `CRON_SECRET` in hosting settings before deploying. Keep the existing cashier
   database if its balances must be preserved. Receipt storage remains separate.
   Vercel Cron uses its bearer header; update external schedulers with the new secret.
5. Set exact `EXPENSE_GROUP_IDS` and `EXPENSE_USER_IDS`, and `LINE_CHANNEL_SECRET`.
   Prefer a dedicated expense group. If sharing the cashier group, image senders
   must be on the expense allowlist; confidently identified cashier reports fall
   through to the existing cashier handler. Other groups preserve existing behavior.
6. Enable `RECEIPTS_ENABLED=true`, keep `FLOWACCOUNT_WRITE_ENABLED=false` for preview.
   Raw LINE signatures are verified before any POST event processing when enabled.
7. Run `npm test`. In the sandbox, verify a real Thai receipt creates one line,
   its image attaches, a second receipt appends, and a month instruction selects
   the intended document. Only then enable `FLOWACCOUNT_WRITE_ENABLED=true` in
   production with production-scoped credentials. Deployment alone does not enable it.

The Vercel endpoint has a 60-second budget. A timeout or crash after a financial
write may leave a permanent recovery lock rather than retrying and duplicating
expenses. Use a durable worker/queue before scaling to bursts or larger batches.
The unchanged root `index.js` is a legacy translator; LINE's webhook must point
at `/api/webhook` for the new feature.

## Recovery

Receipt and month records use `line-expenses:v2:*` in private Redis. Image bodies
expire after seven days; receipt/identity/month records persist for deduplication.
An uncertain create/update is marked in the month's state **before** sending the
request. The writer lock has no expiry on purpose. Never automatically clear it.

If a write times out, inspect the reference `LINE-MONTH-YYYY-MM-bucket` in
FlowAccount and compare actual line markers `[LINE:<receipt-id>]` with the Redis
ledger. Verify both source and destination after a month move. A qualified operator
must reconcile document ID, totals, lines and fingerprint, then clear the unknown
flag/lock. Repeated `expense sync` deliberately refuses an unknown outcome.
Do not recreate the expense because an attachment failed; attach to its known ID.

## Validation

`npm test` uses mocked LINE/FlowAccount/Redis boundaries, not real accounting writes.
It covers signatures, calendar boundaries, grouped totals, month instructions,
photo deduplication, authorized users, paid/manual document guards, uncertain writes,
attachment retries, preview mode and exact-photo quoted acknowledgements.
No live receipt or sandbox document has been created by these automated tests.

Primary API references:
- https://developers.flowaccount.com/tutorial/connect/client-credentials-flow/
- https://developers.flowaccount.com/api-reference/
- https://developers.flowaccount.com/announcements/September-12-2025/
- https://developers.flowaccount.com/releases/release/20251007/
- https://github.com/flowaccount/flowaccount-openapi-sdk-php/blob/main/docs/Api/ExpensesApi.md
- https://developers.line.biz/en/docs/messaging-api/get-quote-tokens/
- https://developers.line.biz/en/docs/messaging-api/sending-messages/

