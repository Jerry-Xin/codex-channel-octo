/** Offline maintenance only. External results must be checked by the operator first. */
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAdapter } from './db-adapter.js';
import { SessionStore } from './session-store.js';
export function reconcile(database: string, session: string, turnId: string, acknowledged: boolean): boolean {
  if (!acknowledged || !database || !session || !turnId) throw new Error('Explicit external-result reconciliation acknowledgment is required');
  if (!existsSync(database)) throw new Error('Database does not exist');
  const lock = join(dirname(resolve(database)), 'gateway.lock');
  // Share the gateway O_EXCL lock protocol; refuse existing locks, even stale ones.
  writeFileSync(lock, `${process.pid} ${randomUUID()}`, { flag: 'wx', mode: 0o600 });
  try {
    const store = new SessionStore(createAdapter(database));
    try { store.init(); return store.reconcileTurn(session, turnId); }
    finally { store.close(); }
  } finally { unlinkSync(lock); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [db, session, turn, confirm] = process.argv.slice(2);
  try {
    if (!reconcile(db, session, turn, confirm === '--external-results-verified')) throw new Error('No matching quarantined turn');
    console.log('Execution quarantine released; no model or tool was rerun');
  } catch {
    console.error('Reconciliation refused: stop the gateway, verify external results and supply the matching database/session/turn ID plus --external-results-verified');
    process.exitCode = 1;
  }
}
