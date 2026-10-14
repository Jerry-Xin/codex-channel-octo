# Default reply selection when exec JSONL omits phase

Tracks #29; follows up #11 and merged #15. Baseline main b381706. No dependency on unmerged #28 and no change to retry/cancellation semantics or attachment support (#27).

## Confirmed source contracts

Codex CLI rust-v0.162.1:

- [Internal MessagePhase](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/protocol/src/models.rs#L944) includes Commentary, PartialAnswer and FinalAnswer; serde uses snake_case. Provider emission is optional/inconsistent.
- [exec JSONL mapping](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/exec/src/event_processor_with_jsonl_output.rs#L148) converts `ThreadItem::AgentMessage { text, .. }` to `AgentMessageItem { text }`, discarding other metadata.
- [Exec event schema](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/exec/src/exec_events.rs#L138) and [SDK item type](https://github.com/openai/codex/blob/rust-v0.162.1/sdk/typescript/src/items.ts#L75) have no phase field. The SDK does not reconstruct one.

OpenClaw d029874 and openclaw-channel-octo bbdb267:

- [Dispatcher](https://github.com/openclaw/openclaw/blob/d0298744306f8bc30468cf9d2726544c6a2517c0/src/auto-reply/reply/reply-dispatcher.ts#L642) assigns tool/block/final literals through program call paths, not model-generated text tags.
- [Octo adapter](https://github.com/Mininglamp-OSS/openclaw-channel-octo/blob/bbdb267fdbfcf79e540fa169b54afd0904a2cdbb/src/inbound.ts#L3559) sends final payloads, replaces its buffered block text and falls back to the last buffered block. This is not Codex's protocol phase.

The previous default phase mode therefore preserves all unknown messages in actual deployed exec streams. Casting an optional field or prompting for special text tags cannot establish a typed final-answer contract.

## Implemented policy

Add `sdk.outputSelection: "final"` and make it the runtime default when unset.

1. Use the existing eligible attempt pool: the final attempt's messages, or its explicitly linked recovery ancestors when it produced none. Never inherit from an unrelated stale attempt.
2. For this mode ignore whitespace-only messages without altering the bytes of selected nonblank text.
3. If explicit final_answer messages exist, keep all of them in first-seen order with blank-line separators. Exclude commentary and partial_answer items.
4. Otherwise keep the last non-commentary item by first-seen sequence. Updates to an old item replace its contents without moving it past a later item.
5. If only commentary exists, keep its last item as an explicit useful fallback. If nothing useful exists, return empty and preserve the existing no-response notice.
6. Log `phase` for explicitly labeled finals, `last_message` for the ordering fallback, and `last_message_partial` for inherited/non-terminal ordering fallback. No text is logged by selection diagnostics.
7. Apply the cap once and feed the identical selected text into delivery and history, preserving mention rendering and splitting behavior.

Existing explicit phase/heuristic/legacy modes remain unchanged, including their own fallback rules. A newly recognized partial_answer is a non-commentary item, not a final signal. No dependency is patched and no reliable metadata is invented.

## Tradeoffs and migration

This deliberately fixes the normal unlabeled-runtime path without claiming semantic certainty. The last unlabeled message may itself be progress/partial content; unlabeled multipart answers may lose earlier pieces. All explicitly labeled final parts are preserved. Users who require every unlabeled part can choose explicit phase; legacy retains separator-free concatenation. A future reliable transport can supply real phase metadata without changing the selection contract.

Changing the code default affects only unset configurations after restart. Explicit phase remains phase: changing config is an operator action, not performed by this PR. Existing bot instances must restart to pick up either code or config changes. toolProgress is independent and unchanged.

## Review and validation

Review invariants: no dependence on unavailable metadata, no text-pattern final classification, no reordering by snapshot arrival, no accidental cross-attempt inheritance, no dropped labeled multipart final, no divergence of delivery/history, and no claim that a partial fallback completed the task.

New regression tests first produced eight failures on the old implementation. Coverage includes unlabeled messages with/without tools, multiple trailing messages, snapshots, blank tails, explicit multipart finals, partial_answer, commentary-only fallback, recovery lineage, no-terminal attempts, unrelated fresh attempts, caps, compatibility modes and the actual SDK-event-to-bridge-to-selector boundary. Pipeline tests exercise default delivery/history parity with unknown phases. These are local/synthetic tests, not a live-provider phase guarantee or a labeled-corpus quality evaluation.

Local validation: SDK 0.142.3 and 0.162.1 each passed 72 files / 1534 tests, plus type-check, zero-warning lint, build and package checks. The package includes this document and the executable JSONL proxy.
