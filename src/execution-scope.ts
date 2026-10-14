import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

/** Only the trusted proxy can acknowledge teardown; SDK errors are not proof. */
export interface ManagedExecution {
  waitForStopped(timeoutMs: number): Promise<boolean>;
  dispose(): void;
}

export class ExecutionScope implements ManagedExecution {
  private readonly directory = mkdtempSync(join(tmpdir(), 'octo-execution-'));
  private readonly token = randomUUID();
  private launchExpected = false;
  constructor() { chmodSync(this.directory, 0o700); }
  environment(base: Record<string, string>): Record<string, string> {
    return { ...base, CODEX_CHANNEL_EXECUTION_DIR: this.directory, CODEX_CHANNEL_EXECUTION_TOKEN: this.token };
  }
  expectLaunch(): void { this.launchExpected = true; }
  confirmNotStarted(): void { this.launchExpected = false; }
  private stopped(): boolean {
    try {
      const path = join(this.directory, 'status.json');
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) return false;
      const status: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return typeof status === 'object' && status !== null
        && 'token' in status && status.token === this.token
        && 'state' in status && status.state === 'stopped';
    } catch { return false; }
  }
  async waitForStopped(timeoutMs: number): Promise<boolean> {
    if (!this.launchExpected) return true;
    const deadline = performance.now() + timeoutMs;
    do {
      if (this.stopped()) return true;
      if (performance.now() >= deadline) return false;
      await sleep(Math.min(25, Math.max(1, deadline - performance.now())));
    } while (true);
  }
  dispose(): void { rmSync(this.directory, { recursive: true, force: true }); }
}
