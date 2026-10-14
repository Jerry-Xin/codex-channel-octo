# Safe failure handling and bounded pre-execution recovery (#26)

Implementation baseline: main b381706. The original analysis is in issue #26 and its comments. This is the implemented runtime policy, rather than a claim that all inference outages are solved.

## Behavior

- Diagnostics use closed stage/category/source/evidence snapshots and a local diagnostic ID. Terminal reports retain first/final failure, attempt count, decision and execution risk. Raw prompts, JSONL records, tool output, subprocess stderr and exception causes are not serialized.
- SDK event text is classified only through tested, anchored patterns. A plain exit code 1 is not a transient error. Rejected JSONL and subprocess stderr are never searched for retry directives. Unknown formats remain unknown.
- A single recovery scheduler bounds attempts, cancellable jittered backoff and elapsed time. It honors a trusted Retry-After minimum without truncating it into an early retry. Current SDK versions do not expose provider headers: the adapter does not invent them or claim it can count CLI-internal network retries.
- New retries default off. With retries on, only a positively established pre-execution temporary failure is eligible in the current runtime (e.g. EAGAIN/EMFILE/ENFILE from OS spawn). A missing thread ID, missing tool event, read-only filesystem sandbox or same-thread continuation does not establish safe execution. SDK HTTP-shaped errors improve diagnostics but cannot establish that tools did not execute.
- Consequently old automatic stream continuation and stale-thread fresh replay are intentionally disabled for uncertain runs, even when new retries are off. Existing thread mappings are retained for operator reconciliation rather than silently cleared. Unused stale-replay callbacks and their per-turn fallback prompt assembly have been removed. This is a safety behavior change, not a claim of complete legacy retry compatibility.
- Timeout revokes publication and propagates AbortSignal to the SDK, relay and network sends. The proxy now confirms owned POSIX group teardown. After handler settlement and teardown proof, the session admits new user requests while preserving a failed-task snapshot; external/detached effects may still require checking. See [the #39 continuity policy](session-continuity.md).
- Timed-out sessions whose managed teardown remains unconfirmed reject new model work; authenticated transport gates and the owner reconciliation command still run. Active turns left by a process crash become quarantined only after the new gateway acquires its singleton lock. TTL, /reset and restart cannot clear execution uncertainty. Normal completion revokes late callback publication as well.
- Shutdown tracks real handlers, cancels active turns and records quarantine for unknown/observed execution before closing the store. Positively unstarted turns remain clean on timeout or shutdown. A timed-out handler's late publication cannot affect a new turn. Cleanup may release only its exact execution generation after managed teardown proof, preserving interruption metadata.

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

The successful #15 output selection modes and capped delivery/history text remain unchanged. Output is selected once, stored in `turn_outputs` before sending and split into fixed payloads/keys persisted atomically in `delivery_parts`. Credentials are excluded from stored delivery payloads. Normal message contents use the existing protected SQLite directory and seven-day retention; /reset deletes the outbox contents along with session history. Execution tombstones contain no message contents. Active/quarantined evidence survives retention; sufficiently old clean tombstones can expire. Startup logs include the paused-session count.

Every attempted part is first marked unknown. Only a positive signed-int64 message ID, with no conflicting returned client key, is confirmed. A send exception, empty response, malformed ID or cancellation after submission cannot count as delivered. Later parts stop at uncertainty. Confirmed completion commits assistant history idempotently by turn ID; failures at delivery or history commit never invoke the model again.

This implementation keeps generated/partially delivered output for inspection. It does not automatically resend unknown outcomes: server-side dedup retention and response contracts have not been live-verified. It does not claim an atomic transaction between Octo and SQLite or exactly-once delivery. A process crash around an external acknowledgment still requires reconciliation. Original pending outputs are not silently treated as delivered conversation history.

Inspect only safe columns during incident response, for example:

```sql
SELECT session_key, turn_id, generation, state, updated_at FROM turn_execution;
SELECT turn_id, state, created_at FROM turn_outputs;
SELECT turn_id, part_index, state, message_id FROM delivery_parts;
```

Do not copy message content, signed URLs or credentials into diagnostic logs.

## Maintenance when managed teardown cannot be confirmed

The normal stopped-execution path requires no owner command. For legacy/crash records or missing teardown proof, first confirm that the task's managed execution has stopped and check any external effects. Cancellation, promise settlement, missing tool events, reset and restart are not external-effect verification.

The registered Octo owner can recover the affected session in-process:

```text
/reconcile TURN_ID --external-results-verified
```

The command passes the normal transport, mention and rate-limit gates, uses registration/transport identity rather than display names or message claims, and runs inside the session queue before the quarantine gate. It does not create a new model turn. It verifies the exact session/turn pair and rejects a retained local handler; database state is authoritative so an offline release cannot be shadowed by an old memory cache. Group commands must mention the bot unless server policy permits no-mention replies. This acknowledgement releases admission for new messages only: it does not replay, resend, mark old output delivered, or reconcile external systems itself.

The offline helper remains available for operator maintenance. Stop the gateway first and use the matching identifiers:

```sh
node dist/reconcile-turn.js /absolute/path/to/data/cc-octo.db SESSION_KEY TURN_ID --external-results-verified
```

It uses the gateway's O_EXCL lock, refuses any existing lock and changes only the exact quarantined row. Restart after offline maintenance. Never remove a live lock to bypass the check. Neither path clears conversation history.

## Verification requirements and limits

Automated coverage includes classification/privacy, positive spawn retries, first/final failure, bounded attempts, jitter/Retry-After budgets, abort during backoff, missing-thread and post-tool failures, durable timeout/restart quarantine, late callback revocation, shutdown, outbox uncertainty, malformed/conflicting acknowledgments and idempotent history commit. The existing real-SDK Unicode/JSONL/termination tests cover the proxy lifecycle, including a backpressured proxy with an uncooperative direct child. None establishes that arbitrary detached/remote effects stop on abort.

Changed legacy recovery tests explicitly test no replay/mapping reset under uncertainty. Successful sender framing and output selection still have byte/behavior checks. No production credentials are used in tests. Live provider availability, externally enforced read-only execution, remote-effect reconciliation and Octo dedup contracts are separate acceptance work. Issue #27 tracks attachment sending and is not implemented by this PR.

## Author review

The self-review checked three cross-cutting boundaries: (1) no replay without positive pre-exec evidence, (2) no late publication after success, cancellation or generation replacement, and (3) no delivery failure causing model replay or falsely committed history. Findings fixed during review included revoking successful-turn callbacks, moving crash quarantine recovery behind singleton ownership, recording unknown delivery before network submission, atomic persistence of all fixed delivery parts, and allowing shutdown to settle the dispatch gate even when dispatch timeouts are disabled.

A negative control deliberately removed the execution-risk guard from retry eligibility: two regression tests failed; restoring the guard passed. Existing behavior tests were migrated where they required unsafe stream/stale replay; normal output selection and sender framing remain covered. The offline helper is tested for explicit acknowledgment, wrong turn IDs, existing gateway locks and nonexistent databases. These are local checks, not independent approval or live provider acceptance.
