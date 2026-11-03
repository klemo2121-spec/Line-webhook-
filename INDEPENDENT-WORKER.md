# Independent receipt worker (pilot, not yet armed)

The local Node process owns a separate Chrome profile and uses the existing OpenAI
API key protected with Windows CurrentUser DPAPI. It never imports the user's
normal Chrome profile, password or cookies. Login is performed manually in the
dedicated receipt browser. Keep the computer and this process running.

`api/browser-events.js` authenticates with the existing worker credential and
proxies Upstash Redis SUBSCRIBE as SSE. Intake publishes a wake after durable
enqueue. Reconnection subscription acknowledgements trigger a queue check, so
missed wakes recover without periodic AI calls. Connections renew every 50 seconds
within the function's 60-second duration. This consumes hosting/Redis allowance;
it does not imply unlimited free hosting. No new paid service or upgrade is enabled.

Run with the bundled Node executable:

- `scripts/expense-runner.mjs check`: a read-only API-key check.
- `scripts/expense-runner.mjs login`: open the dedicated Chrome profile for manual login, no writes.
- `scripts/expense-runner.mjs preflight`: inspect the expense list/form without changing it.
- `scripts/expense-runner.mjs once`: one supervised drain after arming.
- `scripts/expense-runner.mjs start`: subscribe and handle new work after arming.

The Playwright module defaults to the installed bundled runtime. A different
installed module may be selected with EXPENSE_PLAYWRIGHT_MODULE. No remote-debugging
port is exposed and no existing Chrome session is attached.

Login mode now stays alive in the same authenticated browser and accepts private
operator commands from `.local/browser/runner-command.json`: `{"action":"preflight"}`,
`{"action":"once"}` or `{"action":"start"}`. Adapter fixes reload on each command
without restarting Chrome. Login has no timeout. Do not close the browser to run
preflight. Navigation inside an authenticated session uses the actual relative
expense link, avoiding full page reloads. Only the specifically identified FlowAccount
onboarding tutorial can be closed automatically; other modals still block.

Background writes remain disabled without ignored private `runner-ready.json`
containing `verified:true`. A supervised `once` command may test one genuine receipt
before arming, as explicitly authorized by the operator. Do not arm based solely
on unit tests. First verify the dedicated login and adapter against actual UI,
then supervise a genuine new receipt through save, original image attachment/download
hash, and quoted LINE success.
Read-only preflight has passed in the dedicated live browser. The first supervised
image was a screenshot of an expense list, correctly rejected for review before
planning/writing. No live unattended success has yet been established. No auto-start
task is installed.

The image reader uses gpt-4.1-mini Responses API, store:false, at most 1,200 output
tokens per request and 25 requests per Bangkok day. Requests reserve their daily
slot before sending, with no automatic retry. This is a request cap, not a dollar
budget or a verified provider balance. Empty queue checks make no model requests.
The normal project key cannot establish the account's billing balance/admin budget.

The adapter accepts only configured expense company routes, allowed monthly groups,
known expense categories, gross THB, zero VAT/WHT/discount and awaiting documents.
It preserves pre-existing line text, uses one unique receipt marker and verifies
the downloaded saved attachment against the original SHA-256. Bank slips cannot
create expenses/payments. Paid/approved documents, uncertain documents, unknown
saves, login loss or changed UI stop processing; no false success thumb is sent.
An existing writing/planned job is held for reconciliation, never blindly replayed.

Known pilot limitations: the browser adapter has not completed a live test in its
own profile. The run stops on attachment limits; the documented manual ZIP fallback
remains available only after an explicit attachment-count error. Monthly corrections
after claim/save remain manual. Arbitrary free-text instructions are not supported.
Only the existing validated month/group parser applies instructions. Event delivery
is a wake hint; the durable queue and ownership remain the authority.

An untouched reviewed duplicate may be removed from the active queue with
`browser-worker.mjs dismiss FILE`, reason `user_confirmed_no_action`, only after
the human actually confirms no action. It creates no accounting change and sends
no thumbs-up. Unknown financial writes can never be dismissed by this action.
