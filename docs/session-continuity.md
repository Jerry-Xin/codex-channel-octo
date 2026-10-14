# User requests after interrupted tasks (#39)

A task can fail without disabling its conversation. This follows #28's cancellation, publication fencing and no-automatic-replay policy. It separates **execution admission** from **uncertainty about previous effects**.

## Runtime behavior

- A normal user-authored request, including “continue the previous task”, can run in the same session after the interrupted handler has settled and its managed execution has stopped. No `/reconcile` acknowledgment is required on this path. This is a new request with a new turn ID/generation; the original prompt is never automatically resubmitted.
- On timeout, revoke the previous turn's publication/store authority and propagate abort immediately. Requests arriving during cleanup remain in the existing per-session queue. Each request's dispatch timeout starts when its own handler starts, excluding queue wait.
- The trusted proxy creates an owned POSIX process group, forwards termination to that group and escalates to SIGKILL. A private per-attempt control directory and nonce carry a closed teardown acknowledgment after CLI closure and no running group members; zombies cannot execute. Credentials/control paths are stripped from the CLI/tool environment. Sending a signal, promise settlement, an arbitrary SDK error and missing events are not teardown proof.
- The router waits up to three seconds for cleanup before returning control to the queue. If the handler is still alive or proof is unavailable, requests fail visibly rather than overlap the same work environment. A handler that subsequently settles with successful teardown proof releases admission automatically. A subsequent request also rechecks a delayed acknowledgment from a settled handler before deciding whether maintenance is needed. Unobservable, historical and crash-interrupted executions keep the owner maintenance path. Windows currently keeps this conservative fallback because the POSIX group acknowledgment has no Windows Job Object equivalent here.
- Successful normal execution keeps its existing semantics, including intentionally started external/background services. Stopped interrupted execution may already have changed files or external systems. Neither admission reopening nor a teardown acknowledgment asserts external rollback, exactly-once execution or termination of detached/remote work that escaped the owned process group.

## Continuation and history

`interrupted_turns` records task ID, failure/cancellation/timeout reason, stage and execution risk, independently from the session's current execution row. It contains no raw prompt, tool output, SDK exception text, credentials or arbitrary error payload. A subsequent request receives the latest pending closed snapshot alongside the existing sender/security frame and SDK thread mapping. The frame instructs the agent to follow the current request only, inspect actual work before continuing, and verify uncertain operations before repeating them. This instruction assists continuation; it is not an enforceable idempotency boundary for arbitrary tools.

The snapshot is consumed only after a following turn succeeds, without deleting the audit record or marking external effects reconciled. Reset does not erase this interruption metadata. Consumed snapshots use seven-day retention; pending context survives until presented successfully. Historical/crash quarantine is not silently migrated into a stopped execution.

If a thread is invalid or encrypted content cannot be resumed, this change does not add an automatic fresh-thread replay. The error remains explicit. A future thread repair can carry verified history but must not resubmit an already-started request without evidence.

## Tests and boundaries

Coverage includes failed/timeout turns followed by unrelated requests or explicit continuation, queued cleanup, positive non-execution, missing/failed proof, persistent metadata, generation fencing, real SDK failure and resume framing, and an owned subprocess tree whose child ignores SIGTERM. Production socket/gateway/router/handler wiring checks that the next request invokes the model once, carries the interruption snapshot, and delivers its response.

The tests use synthetic local processes and transport fixtures; no production credentials, provider fault injection or live external-effect reconciliation are used. Operator `/reconcile` remains available when cleanup cannot be confirmed. The previous recovery guide describes that maintenance interface.
