import { performance } from 'node:perf_hooks';
import { diagnosticId, type ExecutionRisk } from './agent-failure.js';
/** A timeout revokes publication immediately; releasing a queue never revives it. */
export class TurnContext {
  readonly controller = new AbortController();
  readonly signal: AbortSignal = this.controller.signal;
  readonly deadline: number;
  executionRisk: ExecutionRisk = 'proven_not_started';
  needsReconciliation = false;
  private publishable = true;
  constructor(timeoutMs: number, readonly generation = 1, readonly turnId = diagnosticId()) {
    this.deadline = timeoutMs > 0 ? performance.now() + timeoutMs : Infinity;
  }
  revoke(): void { this.publishable = false; }
  cancel(): void { this.publishable = false; this.controller.abort(); }
  assertPublishable(): void {
    if (performance.now() >= this.deadline) this.cancel();
    if (!this.publishable || this.signal.aborted) {
      throw new DOMException('Turn no longer owns publication', 'AbortError');
    }
  }
  /** All callback/store entrypoints must recheck ownership, including late completions. */
  guard<T extends object>(target: T): T {
    return new Proxy(target, { get: (obj, key) => {
      const value = Reflect.get(obj, key);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => { this.assertPublishable(); return value.apply(obj, args); };
    } });
  }
}
export interface TurnLedger {
  isTurnQuarantined(session: string): boolean;
  getQuarantinedTurnId(session: string): string | undefined;
  getTurnState(session: string): 'active' | 'quarantined' | 'clean' | undefined;
  reconcileTurn(session: string, turnId: string): boolean;
  beginTurn(session: string, turnId: string): number;
  finishTurn(session: string, turnId: string, state: 'clean' | 'quarantined'): void;
}
