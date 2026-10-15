import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';

const settings = vi.hoisted(() => ({ direct: false }));
vi.mock('../jsonl-proxy-path.js', () => ({ resolveJsonlProxyPath: () => settings.direct ? undefined : fileURLToPath(new URL('./fixtures/owned-proxy.mjs', import.meta.url)) }));
vi.mock('@openai/codex-sdk', async importOriginal => {
  const original = await importOriginal<typeof import('@openai/codex-sdk')>();
  return { ...original, Codex: class extends original.Codex {
    constructor(options: ConstructorParameters<typeof original.Codex>[0]) {
      // Redirect only default native executable resolution to our owned fixture;
      // SDK execution, transport, stream parsing and the production bridge stay real.
      super({ ...options, codexPathOverride: options?.codexPathOverride ?? fileURLToPath(new URL('./fixtures/owned-cli.mjs', import.meta.url)) });
    }
  } };
});
vi.mock('../execution-scope.js', async importOriginal => {
  const original = await importOriginal<typeof import('../execution-scope.js')>();
  return { ...original, ExecutionScope: class extends original.ExecutionScope {
    constructor() { super(fileURLToPath(new URL('./fixtures/owned-cli.mjs', import.meta.url))); }
    override environment(base: Record<string, string>) {
      const env = super.environment(base);
      // Grant the fixture the entire synthetic control capability. Admission
      // must be safe even if a same-user tool learns the proxy's credentials.
      return { ...env, OWNED_FORGE_DIR: env.CODEX_CHANNEL_EXECUTION_DIR, OWNED_FORGE_TOKEN: env.CODEX_CHANNEL_EXECUTION_TOKEN };
    }
  } };
});
vi.mock('../octo/api.js', () => ({ sendMessage: vi.fn().mockResolvedValue({ message_id: '1' }), getMentionPreference: vi.fn().mockResolvedValue(false) }));
import { queryAgentEvents } from '../agent-bridge.js';
import { ExecutionScope } from '../execution-scope.js';
import { SessionRouter } from '../session-router.js';
import { SessionStore } from '../session-store.js';
import { createAdapter } from '../db-adapter.js';
import type { Config } from '../config.js';
import { ChannelType, MessageType, type BotMessage } from '../octo/types.js';

let root: string;
let store: SessionStore;
const msg = (content: string): BotMessage => ({ message_id: content, message_seq: 1, from_uid: 'human', channel_id: 'human', channel_type: ChannelType.DM, timestamp: 0, payload: { type: MessageType.Text, content } });
beforeEach(() => {
  settings.direct = false;
  root = mkdtempSync(join(tmpdir(), 'execution-adversarial-'));
  store = new SessionStore(createAdapter(':memory:')); store.init();
  for (const file of ['owned-cli.mjs', 'owned-proxy.mjs']) chmodSync(fileURLToPath(new URL('./fixtures/' + file, import.meta.url)), 0o755);
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
function config(mode: string): Config {
  return { baseDir:root, dataDir:join(root,'data'), botToken:'fake', apiUrl:'https://test.invalid', maxResponseChars:524288, cwd: root, cwdBase: root, sdk: { env: {
    OWNED_MODE: mode, OWNED_PID_FILE: join(root, 'child'), OWNED_PARENT_PID_FILE: join(root, 'parent'),
    OWNED_EFFECT_FILE: join(root, 'effects'), OWNED_REPORT_FILE: join(root, 'report'),
  } }, dispatchTimeoutMs: 10000, rateLimit: { maxPerMinute: 100 }, context: { maxContextChars: 6000, historyLimit: 40 } };
}

describe.skipIf(process.platform === 'win32')('admission ignores forged teardown evidence', () => {
  it('correct-nonce proof cannot reopen admission while a ready owned descendant keeps writing', async () => {
    const cfg = config('forged-failure');
    const router = new SessionRouter(cfg, 'bot', 'owner', store);
    let scope!: ExecutionScope;
    let handlerSettled = false;
    const first = router.routeAndHandle(msg('first'), async (_result, turn) => {
      try {
        for await (const event of queryAgentEvents('first', cfg, undefined, undefined, {
          onManagedExecution: execution => { scope = execution as ExecutionScope; turn.registerExecution(execution); },
          onExecutionRisk: risk => { turn.executionRisk = risk; },
        })) void event;
      } finally { handlerSettled = true; }
    });
    try {
      await vi.waitFor(() => {
        expect(handlerSettled).toBe(true);
        expect(existsSync(join(root, 'child'))).toBe(true);
      }, { timeout: 3000 });
      const env = scope.environment({});
      expect(JSON.parse(readFileSync(join(env.CODEX_CHANNEL_EXECUTION_DIR, 'status.json'), 'utf8')))
        .toMatchObject({ state: 'stopped', token: env.CODEX_CHANNEL_EXECUTION_TOKEN });
      await new Promise<void>((resolve, reject) => {
        const forged = createConnection(join(env.CODEX_CHANNEL_EXECUTION_DIR, 'control.sock'));
        forged.once('connect', () => forged.write(JSON.stringify({token:env.CODEX_CHANNEL_EXECUTION_TOKEN,type:'exit',state:'stopped'})+'\n'));
        forged.once('close', () => resolve()); forged.once('error', reject);
      });
      expect(await scope.waitForStopped(0)).toBe(false);
      const next = vi.fn(async () => {});
      const queued = router.routeAndHandle(msg('next'), next);
      const size = existsSync(join(root, 'effects')) ? readFileSync(join(root, 'effects')).length : 0;
      await new Promise(resolve => setTimeout(resolve, 75));
      expect(next).not.toHaveBeenCalled();
      expect(readFileSync(join(root, 'effects')).length).toBeGreaterThan(size);
      await first; await queued;
      expect(next).toHaveBeenCalledOnce();
      const finalSize = readFileSync(join(root, 'effects')).length;
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(readFileSync(join(root, 'effects')).length).toBe(finalSize);
    } finally { scope?.dispose(); await first; }
  }, 8000);

  it('direct fallback receives no control credentials and stays quarantined despite a matching proof file', async () => {
    settings.direct = true;
    const cfg = config('failure');
    const router = new SessionRouter(cfg, 'bot', 'owner', store);
    let scope!: ExecutionScope;
    await router.routeAndHandle(msg('first'), async (_result, turn) => {
      try {
        for await (const event of queryAgentEvents('first', cfg, undefined, undefined, {
          onManagedExecution: execution => { scope = execution as ExecutionScope; turn.registerExecution(execution); },
          onExecutionRisk: risk => { turn.executionRisk = risk; },
        })) void event;
      } finally {
        const env = scope.environment({});
        writeFileSync(join(env.CODEX_CHANNEL_EXECUTION_DIR, 'status.json'), JSON.stringify({ token: env.CODEX_CHANNEL_EXECUTION_TOKEN, state: 'stopped' }));
      }
    });
    try {
      expect(JSON.parse(readFileSync(join(root, 'report'), 'utf8'))).toEqual({ control: false, token: false });
      expect(await scope.waitForStopped(0)).toBe(false);
      const next = vi.fn();
      expect((await router.routeAndHandle(msg('next'), next))?.rejectionReason).toBe('quarantined');
      expect(next).not.toHaveBeenCalled();
    } finally { scope.dispose(); }
  }, 10000);
});
