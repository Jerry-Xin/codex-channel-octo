# Safe failure handling and bounded pre-execution recovery (#26)

Implementation baseline: main b381706. The original analysis is in issue #26 and its comments. This is the implemented runtime policy, rather than a claim that all inference outages are solved.

## Behavior

- Diagnostics use closed stage/category/source/evidence snapshots and a local diagnostic ID. Terminal reports retain first/final failure, attempt count, decision and execution risk. Raw prompts, JSONL records, tool output, subprocess stderr and exception causes are not serialized.
- SDK event text is classified only through tested, anchored patterns. A plain exit code 1 is not a transient error. Rejected JSONL and subprocess stderr are never searched for retry directives. Unknown formats remain unknown.
- A single recovery scheduler bounds attempts, cancellable jittered backoff and elapsed time. It honors a trusted Retry-After minimum without truncating it into an early retry. Current SDK versions do not expose provider headers: the adapter does not invent them or claim it can count CLI-internal network retries.
- New retries default off. With retries on, only a positively established pre-execution temporary failure is eligible in the current runtime (e.g. EAGAIN/EMFILE/ENFILE from OS spawn). A missing thread ID, missing tool event, read-only filesystem sandbox or same-thread continuation does not establish safe execution. SDK HTTP-shaped errors improve diagnostics but cannot establish that tools did not execute.
- Consequently old automatic stream continuation and stale-thread fresh replay are intentionally disabled for uncertain runs, even when new retries are off. Existing thread mappings are retained for operator reconciliation rather than silently cleared. The old callback options remain source-compatible but are no longer invoked for unproven stale failures. This is a safety behavior change, not a claim of complete legacy retry compatibility.
- Timeout revokes publication and propagates AbortSignal to the SDK, relay and network sends. The existing JSONL proxy forwards termination and escalates an uncooperative direct child. External commands, detached children or remote writes may outlive cancellation: the session remains quarantined instead of claiming termination or exactly-once execution.
- Timed-out sessions reject queued/new work before routing and state mutation. Active turns left by a process crash become quarantined only after the new gateway acquires its singleton lock. TTL, /reset and restart cannot clear execution uncertainty. Normal completion revokes late callback publication as well.
- Shutdown tracks real handlers, cancels active turns and records quarantine before closing the store. A timed-out handler's late completion cannot overwrite the quarantine or a new turn's state.

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

The successful #15 output selection modes and capped delivery/history text remain unchanged. Output is selected once, stored in `turn_outputs` before sending and split into fixed payloads/keys persisted atomically in `delivery_parts`. Credentials are excluded from stored delivery payloads. Normal message contents use the existing protected SQLite directory and seven-day retention; /reset deletes the outbox contents along with session history. Execution tombstones contain no message contents and are retained until reconciliation.

Every attempted part is first marked unknown. Only a positive signed-int64 message ID, with no conflicting returned client key, is confirmed. A send exception, empty response, malformed ID or cancellation after submission cannot count as delivered. Later parts stop at uncertainty. Confirmed completion commits assistant history idempotently by turn ID; failures at delivery or history commit never invoke the model again.

This implementation keeps generated/partially delivered output for inspection. It does not automatically resend unknown outcomes: server-side dedup retention and response contracts have not been live-verified. It does not claim an atomic transaction between Octo and SQLite or exactly-once delivery. A process crash around an external acknowledgment still requires reconciliation. Original pending outputs are not silently treated as delivered conversation history.

Inspect only safe columns during incident response, for example:

```sql
SELECT session_key, turn_id, generation, state, updated_at FROM turn_execution;
SELECT turn_id, state, created_at FROM turn_outputs;
SELECT turn_id, part_index, state, message_id FROM delivery_parts;
```

Do not copy message content, signed URLs or credentials into diagnostic logs.

## Releasing an execution quarantine

First stop the gateway, then confirm that relevant managed execution has stopped and reconcile any external effects. Restarting the gateway alone does not do that. After verification, use the matching session and turn IDs:

```sh
node dist/reconcile-turn.js /absolute/path/to/data/cc-octo.db SESSION_KEY TURN_ID --external-results-verified
```

The offline helper takes the same O_EXCL gateway.lock in the database directory, refuses any existing lock, and updates only the matching quarantined row. It never starts a model/tool, clears history or automatically reconciles external systems. A wrong ID or missing acknowledgment fails. Start the gateway again afterwards. Do not remove an existing live lock to bypass the refusal.

## Verification requirements and limits

Automated coverage includes classification/privacy, positive spawn retries, first/final failure, bounded attempts, jitter/Retry-After budgets, abort during backoff, missing-thread and post-tool failures, durable timeout/restart quarantine, late callback revocation, shutdown, outbox uncertainty, malformed/conflicting acknowledgments and idempotent history commit. The existing real-SDK Unicode/JSONL/termination tests cover the proxy lifecycle, including a backpressured proxy with an uncooperative direct child. None establishes that arbitrary detached/remote effects stop on abort.

Changed legacy recovery tests explicitly test no replay/mapping reset under uncertainty. Successful sender framing and output selection still have byte/behavior checks. No production credentials are used in tests. Live provider availability, externally enforced read-only execution, remote-effect reconciliation and Octo dedup contracts are separate acceptance work. Issue #27 tracks attachment sending and is not implemented by this PR.

## Author review

The self-review checked three cross-cutting boundaries: (1) no replay without positive pre-exec evidence, (2) no late publication after success, cancellation or generation replacement, and (3) no delivery failure causing model replay or falsely committed history. Findings fixed during review included revoking successful-turn callbacks, moving crash quarantine recovery behind singleton ownership, recording unknown delivery before network submission, atomic persistence of all fixed delivery parts, and allowing shutdown to settle the dispatch gate even when dispatch timeouts are disabled.

A negative control deliberately removed the execution-risk guard from retry eligibility: two regression tests failed; restoring the guard passed. Existing behavior tests were migrated where they required unsafe stream/stale replay; normal output selection and sender framing remain covered. The offline helper is tested for explicit acknowledgment, wrong turn IDs, existing gateway locks and nonexistent databases. These are local checks, not independent approval or live provider acceptance.
