# Safe failure handling and bounded pre-execution recovery (#26)

Implementation baseline: main b381706. The original analysis is in issue #26 and its comments. This is the implemented runtime policy, rather than a claim that all inference outages are solved.

## Behavior

- Diagnostics use closed stage/category/source/evidence snapshots and a local diagnostic ID. Terminal reports retain first/final failure, attempt count, decision and execution risk. Raw prompts, JSONL records, tool output, subprocess stderr and exception causes are not serialized.
- SDK event text is classified only through tested, anchored patterns. A plain exit code 1 is not a transient error. Rejected JSONL and subprocess stderr are never searched for retry directives. Unknown formats remain unknown.
- A single recovery scheduler bounds attempts, cancellable equal-jitter backoff (half-to-full exponential delay) and elapsed time. It honors a trusted Retry-After minimum without truncating it into an early retry. Current SDK versions do not expose provider headers: the adapter does not invent them or claim it can count CLI-internal network retries.
- New retries default off. With retries on, only a positively established pre-execution temporary failure is eligible in the current runtime (e.g. EAGAIN/EMFILE/ENFILE from OS spawn). A missing thread ID, missing tool event, read-only filesystem sandbox or same-thread continuation does not establish safe execution. SDK HTTP-shaped errors improve diagnostics but cannot establish that tools did not execute.
- Consequently old automatic stream continuation and stale-thread fresh replay are intentionally disabled for uncertain runs, even when new retries are off. Existing thread mappings are retained for operator reconciliation rather than silently cleared. Unused stale-replay callbacks and their per-turn fallback prompt assembly have been removed. This is a safety behavior change, not a claim of complete legacy retry compatibility.
- Timeout revokes publication and propagates AbortSignal to the SDK, relay and network sends. The existing JSONL proxy forwards termination and escalates an uncooperative direct child. External commands, detached children or remote writes may outlive cancellation: the session remains quarantined instead of claiming termination or exactly-once execution.
- Uncertain timed-out sessions reject new model work; authenticated transport gates and the owner reconciliation command still run. Active turns left by a process crash become quarantined only after the new gateway acquires its singleton lock. TTL, /reset and restart cannot clear execution uncertainty. Normal completion revokes late callback publication as well.
- Shutdown tracks real handlers, cancels active turns and records quarantine for unknown/observed execution before closing the store. Positively unstarted turns remain clean on timeout or shutdown. A timed-out handler's late completion cannot overwrite the quarantine or a new turn's state.

## Configuration

```json
{
  "sdk": {
    "recovery": {
      "enabled": false,
      "maxAttempts": 3,
      "maxElapsedMs": 60000,
      "baseDelayMs": 1000,
      "maxDelayMs": 10000
    }
  }
}
```

Settings take effect at bot startup. Attempts include the original execution and are shared across adapter retries. Numeric settings must be positive integers; maxAttempts <= 5, maxElapsedMs <= 300000, delay values <= 60000 and baseDelayMs <= maxDelayMs. Unknown options are rejected. Recovery elapsed time starts at the first failure; the dispatch deadline is never extended. CLI/SDK internal retries consume that dispatch time, and the adapter does not assume a single network attempt per process.

The unrestricted shell/MCP runtime offers no enforceable read-only capability proof. Enabling recovery therefore does **not** enable automatic replay of arbitrary 429/5xx, stream or parse failures. Extending eligibility requires a real tool permission boundary or a business-specific external-result reconciler; there is deliberately no user-configurable “trust that tools did not run” bypass.

## Delivery and storage

The successful #15 output selection modes and capped delivery/history text remain unchanged. Output is selected once, stored in `turn_outputs` before sending and split into fixed payloads/local correlation UUIDs persisted atomically in `delivery_parts`. These request IDs do not establish bot-endpoint idempotency: the server may ignore/replace `client_msg_no`. They must never justify an automatic resend. Credentials are excluded from stored delivery payloads. Normal message contents use the existing protected SQLite directory and seven-day retention. Generated output and delivery-part evidence belonging to the current active/quarantined turn are exempt from that automatic sweep; after release they become eligible for normal expiry. Explicit /reset still deletes outbox contents along with session history, and is not an execution reconciliation. Execution tombstones contain no message contents. Active/quarantined evidence survives automatic retention; sufficiently old clean tombstones can expire. Startup logs include the paused-session count.

Every attempted part is first marked unknown. A positive signed-int64 message ID returned by the awaited send HTTP request confirms server acceptance. The returned client key may differ from the submitted local correlation ID and does not invalidate that acknowledgement. Server acceptance is not proof of client receipt/read status. A send exception, empty response, malformed ID or cancellation after submission cannot count as delivered. Later parts stop at uncertainty. Confirmed completion commits assistant history idempotently by turn ID; failures at delivery or history commit never invoke the model again.

This implementation keeps generated/partially delivered output for inspection. It does not automatically resend unknown outcomes: there is no established server-side deduplication contract for these local IDs. A local live probe verified a valid message ID with a rewritten client key and successful delivery/history commit; it did not establish idempotent resend semantics. It does not claim an atomic transaction between Octo and SQLite or exactly-once delivery. A process crash around an external acknowledgment still requires reconciliation. Original pending outputs are not silently treated as delivered conversation history.

Inspect only safe columns during incident response, for example:

```sql
SELECT session_key, turn_id, generation, state, updated_at FROM turn_execution;
SELECT turn_id, state, created_at FROM turn_outputs;
SELECT turn_id, part_index, state, message_id FROM delivery_parts;
```

Do not copy message content, signed URLs or credentials into diagnostic logs.

## Releasing an execution quarantine

First confirm that the task's managed execution has stopped and check any external effects. Cancellation, promise settlement, missing tool events, reset and restart are not external-effect verification.

After checking external effects, the registered Octo owner can recover a session in-process. In the affected conversation:

```text
/reconcile TURN_ID --external-results-verified
```

For a third-party DM or a group the owner cannot join, send this from the owner's own DM with the bot:

```text
/reconcile TURN_ID --session SESSION_KEY --external-results-verified
```

A non-owner pause notice includes the session key and turn ID to give to the owner. Explicit targets are allowed only from an authenticated owner DM; omitting the target always refers to the current conversation. The session and turn ID must both match. Active rows and retained live local handlers are refused with distinct explanations. Whitespace between arguments is flexible; session keys are exact, whitespace-free transport identifiers.

Privileged authorization accepts the exact registration `owner_uid`, or its single scoped alias explicitly named in the server registration `owner_channel_id` (a compound channel must also include this bot's endpoint). No alias is inferred from an incoming UID or channel. The gateway refreshes both bindings on registration/token refresh. If the server supplies no usable scoped binding, a prefixed UID fails closed; it must not be authorized by suffix similarity. Prompt `is_owner` metadata is advisory and is not this privileged gate.

The command passes transport, mention and sender/session rate limits before quarantine. Paused-session messages do not consume or block on the shared global model-request budget; per-sender/session budgets still bound notice traffic. Unauthenticated commands on healthy sessions receive no reply and are excluded from model context. The command runs inside the source session queue; the target live-handler/state checks and exact SQLite update run synchronously without nested cross-session locks. It does not create a new model turn. It verifies the exact session/turn pair and rejects a retained local handler; database state is authoritative so an offline release cannot be shadowed by an old memory cache. Group commands must mention the bot unless server policy permits no-mention replies. This acknowledgement releases admission for new messages only: it does not replay, resend, mark old output delivered, or reconcile external systems itself.

The offline helper remains available for operator maintenance. Stop the gateway first and use the matching identifiers:

```sh
node dist/reconcile-turn.js /absolute/path/to/data/cc-octo.db SESSION_KEY TURN_ID --external-results-verified
```

It uses the gateway's O_EXCL lock, refuses any existing lock and changes only the exact quarantined row. Restart after offline maintenance. Never remove a live lock to bypass the check. Neither path clears conversation history.

## Verification requirements and limits

Automated coverage includes classification/privacy, positive spawn retries, first/final failure, bounded attempts, jitter/Retry-After budgets, abort during backoff, missing-thread and post-tool failures, durable timeout/restart quarantine, late callback revocation, shutdown, outbox uncertainty, malformed acknowledgments and server-rewritten client keys and idempotent history commit. The existing real-SDK Unicode/JSONL/termination tests cover the proxy lifecycle, including a backpressured proxy with an uncooperative direct child. None establishes that arbitrary detached/remote effects stop on abort.

Changed legacy recovery tests explicitly test no replay/mapping reset under uncertainty. Successful sender framing and output selection still have byte/behavior checks. No production credentials are used in tests. Live provider availability, externally enforced read-only execution and remote-effect reconciliation remain separate acceptance work. Server-side idempotency would require an explicit API contract before any future resend feature. Issue #27 tracks attachment sending and is not implemented by this PR.

## Author review

The self-review checked three cross-cutting boundaries: (1) no replay without positive pre-exec evidence, (2) no late publication after success, cancellation or generation replacement, and (3) no delivery failure causing model replay or falsely committed history. Findings fixed during review included revoking successful-turn callbacks, moving crash quarantine recovery behind singleton ownership, recording unknown delivery before network submission, atomic persistence of all fixed delivery parts, and allowing shutdown to settle the dispatch gate even when dispatch timeouts are disabled.

A negative control deliberately removed the execution-risk guard from retry eligibility: two regression tests failed; restoring the guard passed. Existing behavior tests were migrated where they required unsafe stream/stale replay; normal output selection and sender framing remain covered. The offline helper is tested for explicit acknowledgment, wrong turn IDs, existing gateway locks and nonexistent databases. These are local checks, not independent approval or live provider acceptance.

## API diagnostics

REST errors carry a closed endpoint template, HTTP status (when available), stage,
and failure detail (`http_status`, `network`, `response_read`, `invalid_json`).
Only sendMessage uses the delivery stage; registration, heartbeat, typing,
history and other preparation requests use prepare. Query strings, group/thread
identifiers, server error bodies, statusText and raw causes are withheld for POST,
GET and upload-credential requests alike. No secret-bearing body is retained as
"sanitized" evidence. Endpoint/status remain visible to startup operators.

The dispatch timeout default remains 300 seconds. Choose a longer value for
long-running workflows; increasing it does not make uncertain execution replay
safe. Timeout before SDK execution stays clean; unknown/observed execution pauses
until the registered owner explicitly reconciles it.

The query API intentionally removes obsolete `onResumeFailed` / `fallbackRetryPrompt`
options and the unused `isStreamInterruptError` export, rather than accepting
callbacks that cannot run. `AgentOutputEvent.reason` is narrowed to `initial` and
`request_retry`. Current producers always emit `continues: null`; the collector
keeps legacy lineage handling defensively, not as an enabled recovery mechanism.

## Latest review verification

The owner-control change is tested against real SQLite/router state for unbound
prefixes, the single registration-bound prefix, binding refresh, explicit
third-party DM recovery, exact session/turn matching, retained handlers, active
rows and paused traffic's global-rate isolation. Retention tests preserve paused
output/parts past seven days and expire them normally after release. Structured
API tests deny raw bodies/causes while retaining endpoint/status/read/parse facts.
The server's pinned [BotSendMessageReq](https://github.com/Mininglamp-OSS/octo-server/blob/32ffcff4539736d833a0e61e1ef2e31e83b51a74/modules/bot_api/send.go)
was independently inspected: it has no client_msg_no field, so the correlation
UUID must not be called a remote dedup key.

SDK 0.142.3 and 0.162.1 each passed 76 files / 1602 tests serially; production
type-check, zero-warning lint and build passed. Strict checking of the new API,
recovery and modified bridge/selection contract tests reports zero diagnostics.
Five negative controls (restore suffix-only auth, ignore explicit targets,
charge paused traffic globally, expire unresolved evidence, and classify all
POSTs as delivery) all fail the corresponding new regressions, then pass after
restoration. An unrelated filesystem-watcher timing failure in a parallel run
passed isolated and in both serial full runs; its implementation was not changed.
This follow-up does not deploy the bot, rerun uncertain tasks, automatically
resend messages or establish termination of remote/detached effects.
