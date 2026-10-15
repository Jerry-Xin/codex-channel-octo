# Private operator failure diagnostics

Closes #36. This is separate from execution recovery: enabling it never changes quarantine, owner reconciliation, retries, model invocation, or delivery confirmation.

## Enable and locate

`privateDiagnostics` is a validated boolean under `sdk`, inherited from global defaults and overridable per bot. It is off when absent or false. Set it to true and restart/re-add the bot. Local records are at `<bot>/data/diagnostics/agent-failures.jsonl`, with `.1` and `.2` rotations. The directory is mode 0700 and files are mode 0600. Files and the diagnostics directory must be regular/non-symlink paths; unsafe paths, oversized pre-existing files, and I/O errors fail closed without changing task handling.

## Recorded fields and privacy

Records carry a generated diagnostic ID, timestamp, closed first/final stage/category/source/evidence snapshots, bounded status/retry metadata, attempts, execution risk/decision, Node version, and optional SDK event provenance. Arbitrary SDK text is never persisted: its bounded prefix is SHA-256 fingerprinted, with byte length and a truncation marker. This lets an operator group recurring unknown failures without storing a prompt, token, URL, provider payload, stack, exception cause, raw JSONL or tool stdout/stderr. System error codes are drawn from Node's OS-code allowlist. Public errors and Octo replies do not contain the private context.

A fingerprint cannot reconstruct the original error or prove its cause. `unknown` remains unknown; matching fingerprints are correlation hints, not safe-retry evidence. The facility intentionally does not reproduce the unrestricted raw-error logger used in local incident debugging. Add new recognized error patterns through reviewed, tested classification changes instead of turning raw payload capture on.

## Bounds and failures

Records are capped at 16 KiB. The active file is rotated before a record would exceed 1 MiB; at most the active file and two previous files remain (3 MiB total). This is size retention, not a time guarantee. Changing the feature to false stops writes and leaves existing records intact. Diagnostic failures emit only a fixed warning; they do not replace the original error, rerun a task, or fail the bot. Each bot has a separate data directory.

No production credentials or backend fault injection are used in the regression tests. Real loopback transport/process tests validate the existing harness, not a live provider's error taxonomy.
