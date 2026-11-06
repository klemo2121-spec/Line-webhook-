# Windows listener handover

These optional operator utilities transfer the existing local worker identity between two Windows accounts without printing credentials or starting the listener. They do not change accounting behavior.

Keep all runtime data under ignored `.local/migration`. Copy the owner's private handover/data package separately; it must never be committed to this repository. Public source contains no actual machine binding, user identity, credential, receipt or payee data.

Run `node --test tools/migration/transfer-crypto.test.mjs`. On the old computer, `node tools/migration/windows-transfer.mjs source-info` records the source Windows binding. The supplied private handover package already contains that record; do not replace it. Run `selftest` on the new computer, expecting `isSource:false`, then `receiver-init`. Return only receiver-public.json and its fingerprint to the original operator. The private recipient key remains DPAPI protected on the new computer.

On the old computer: `export PUBLIC_FILE EXPECTED_FINGERPRINT` emits an RSA-OAEP-SHA256/AES-256-GCM credential envelope, with no plaintext secret files. On the new computer: `import ENCRYPTED_FILE` re-protects the original credentials using that account's Windows DPAPI and preserves workerId. An ordinary copy of the old DPAPI files is insufficient. A missing/incorrect machine binding, unknown target credential or interrupted import blocks automatic replacement.

Then run the event worker's `check` mode only. Keep the old listener working until the new read-only preflight passes. Coordinate a single-listener cutover: stop the old listener at an idle boundary, refresh the receipt-reading attempts/cache and daily usage, then start one new listener. Never blindly replay a writing/uncertain expense, reset the durable queue, enable an old bot, or create a test financial document.

An import result is not proof of a live receipt succeeding or of billing balance. All helpers must run from an explicitly selected local workspace on the intended computer. New source commits containing these utilities require no production deployment.
