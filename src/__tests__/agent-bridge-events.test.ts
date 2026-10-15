import { fileURLToPath } from 'node:url';
import { TurnFailure } from '../agent-failure.js';
/**
 * agent-bridge typed-event tests (queryAgentEvents) — mocked @openai/codex-sdk.
 * Covers work identity / first-sight seq, message phase and revisions, attempt
 * markers across recovery and fresh retry, and the canonical options contract.
 */
import { describe, it, expect, expectTypeOf, vi, beforeEach } from 'vitest';

type Ev = Record<string, unknown>;
let scriptedRuns: Array<() => AsyncGenerator<Ev>>;
let runIdx: number;

function makeThread() {
  return {
    async runStreamed(_prompt: string) {
      void _prompt;
      const gen = scriptedRuns[runIdx++];
      if (!gen) throw new Error('no scripted run left');
      return { events: gen() };
    },
  };
}

vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    startThread() {
      return makeThread();
    }
    resumeThread() {
      return makeThread();
    }
  },
}));

vi.mock('../execution-scope.js', async importOriginal => {
  const original = await importOriginal<typeof import('../execution-scope.js')>();
  return {...original, ExecutionScope: class extends original.ExecutionScope {
    constructor() { super(fileURLToPath(new URL('./fixtures/owned-cli.mjs', import.meta.url))); }
  }};
});

import { queryAgent, queryAgentEvents } from '../agent-bridge.js';
import type { AgentOutputEvent, QueryAgentOptions } from '../agent-bridge.js';
import type { Config } from '../config.js';
import type { ManagedExecution } from '../execution-scope.js';

function cfg(): Config {
  return {
    botToken: 't',
    apiUrl: 'https://example.com',
    baseDir: '/tmp/cco-test',
    cwd: '/tmp/cco-test/ws',
    cwdBase: '/tmp/cco-test/ws',
    dataDir: '/tmp/cco-test/data',
    sdk: {},
    rateLimit: { maxPerMinute: 5 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    maxResponseChars: 524288,
    dispatchTimeoutMs: 300000,
  } as Config;
}

async function events(opts?: QueryAgentOptions, onToolUse?: (n: string, i?: unknown) => void): Promise<AgentOutputEvent[]> {
  const out: AgentOutputEvent[] = [];
  for await (const ev of queryAgentEvents('hi', cfg(), undefined, onToolUse, opts)) out.push(ev);
  return out;
}

const started = (id: string): Ev => ({ type: 'thread.started', thread_id: id });
const turnDone: Ev = { type: 'turn.completed', usage: {} };
const msg = (id: string, text: string, extra: Record<string, unknown> = {}, phase: 'completed' | 'updated' = 'completed'): Ev => ({
  type: `item.${phase}`,
  item: { id, type: 'agent_message', text, ...extra },
});
const item = (id: string, type: string, phase: 'started' | 'updated' | 'completed', extra: Record<string, unknown> = {}): Ev => ({
  type: `item.${phase}`,
  item: { id, type, ...extra },
});
const interrupt = 'Codex Exec exited with code 1: Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)';
const staleErr = 'thread not found';

beforeEach(() => {
  runIdx = 0;
  scriptedRuns = [];
});

it('retains positive non-execution proof for an earlier spawn retry scope',async()=>{
  scriptedRuns=[async function*(){throw Object.assign(new Error('synthetic'),{code:'EAGAIN',syscall:'spawn proxy'});},async function*(){yield started('thread');yield {type:'turn.failed',error:{message:'synthetic failure'}};}];
  const config=cfg();config.sdk.recovery={enabled:true,baseDelayMs:1,maxDelayMs:1};const scopes:ManagedExecution[]=[];
  try{
    await expect((async()=>{for await(const event of queryAgentEvents('current request',config,undefined,undefined,{onManagedExecution:scope=>{scopes.push(scope);}}))void event;})()).rejects.toMatchObject({report:{first:{stage:'spawn'},attempts:2}});
    expect(scopes).toHaveLength(2);expect(runIdx).toBe(2);
    expect(await scopes[0].waitForStopped(0)).toBe(true);
    expect(await scopes[1].waitForStopped(0)).toBe(false); // Mocked SDK launches no gateway-owned process.
  }finally{scopes.forEach(scope=>scope.dispose());}
});

describe('work events', () => {
  it('T22: item.started X + item.completed X → exactly one work event with the started seq', async () => {
    scriptedRuns = [async function* () {
      yield started('t1');
      yield item('item_0', 'command_execution', 'started', { command: 'ls', status: 'in_progress' });
      yield item('item_0', 'command_execution', 'completed', { command: 'ls', aggregated_output: 'SECRET', status: 'completed' });
      yield msg('item_1', 'done');
      yield turnDone;
    }];
    const evs = await events();
    const work = evs.filter((e) => e.kind === 'work');
    expect(work).toEqual([{ kind: 'work', attempt: 0, itemId: 'item_0', seq: 0, itemType: 'command_execution' }]);
    const m = evs.find((e) => e.kind === 'message');
    expect(m).toMatchObject({ itemId: 'item_1', seq: 1 });
    // Work events never carry payloads.
    expect(JSON.stringify(work)).not.toContain('SECRET');
    expect(JSON.stringify(work)).not.toContain('ls');
  });

  it('T23: started X, no completion, reconciled completion at turn end → still one event', async () => {
    scriptedRuns = [async function* () {
      yield started('t1');
      yield item('item_0', 'mcp_tool_call', 'started', { server: 's', tool: 't', status: 'in_progress' });
      yield msg('item_1', 'final');
      yield item('item_0', 'mcp_tool_call', 'updated', { server: 's', tool: 't', status: 'in_progress' });
      yield item('item_0', 'mcp_tool_call', 'completed', { server: 's', tool: 't', status: 'failed' });
      yield turnDone;
    }];
    const evs = await events();
    expect(evs.filter((e) => e.kind === 'work')).toEqual([
      { kind: 'work', attempt: 0, itemId: 'item_0', seq: 0, itemType: 'mcp_tool_call' },
    ]);
  });

  it('T24: file_change completed-only → one work event at the completion seq', async () => {
    scriptedRuns = [async function* () {
      yield started('t1');
      yield msg('item_0', 'before');
      yield item('item_1', 'file_change', 'completed', { changes: [], status: 'completed' });
      yield turnDone;
    }];
    const evs = await events();
    expect(evs.filter((e) => e.kind === 'work')).toEqual([
      { kind: 'work', attempt: 0, itemId: 'item_1', seq: 1, itemType: 'file_change' },
    ]);
  });

  it('unknown item types are work; reasoning, todo_list and drained notices are not', async () => {
    scriptedRuns = [async function* () {
      yield started('t1');
      yield item('item_0', 'reasoning', 'started', { text: 'r' });
      yield item('item_1', 'todo_list', 'started', { items: [] });
      yield item('item_2', 'error', 'completed', { message: 'Model metadata for `x` not found. Defaulting to fallback metadata.' });
      yield item('item_3', 'collab_tool_call', 'started', {});
      yield item('item_4', 'web_search', 'completed', { query: 'q' });
      yield turnDone;
    }];
    const evs = await events();
    expect(evs.filter((e) => e.kind === 'work').map((e) => (e as { itemType: string }).itemType)).toEqual([
      'collab_tool_call',
      'web_search',
    ]);
  });
});

describe('message events', () => {
  it('phase is read defensively; 0.142.3 items have none', async () => {
    scriptedRuns = [async function* () {
      yield started('t1');
      yield msg('item_0', 'a');
      yield msg('item_1', 'b', { phase: 'commentary' });
      yield msg('item_2', 'c', { phase: 'final_answer' });
      yield msg('item_3', 'd', { phase: 'something_else' });
      yield turnDone;
    }];
    const phases = (await events()).filter((e) => e.kind === 'message').map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(['unknown', 'commentary', 'final_answer', 'unknown']);
  });

  it('T2: a snapshot of the same item keeps its first-sight seq', async () => {
    scriptedRuns = [async function* () {
      yield started('t1');
      yield msg('item_0', 'v1', {}, 'updated');
      yield msg('item_1', 'other');
      yield msg('item_0', 'v2');
      yield turnDone;
    }];
    const ms = (await events()).filter((e) => e.kind === 'message');
    expect(ms.map((e) => [(e as { itemId: string }).itemId, (e as { seq: number }).seq, (e as { text: string }).text])).toEqual([
      ['item_0', 0, 'v1'],
      ['item_1', 1, 'other'],
      ['item_0', 0, 'v2'],
    ]);
  });
});

describe('attempt markers', () => {
  it('T5: a stream without turn.completed ends with terminal no_terminal', async () => {
    scriptedRuns = [async function* () {
      yield started('t1');
      yield msg('item_0', 'partial');
      yield item('item_1', 'command_execution', 'started', { command: 'sleep 60' });
    }];
    const evs = await events();
    expect(evs[0]).toEqual({ kind: 'attempt_start', attempt: 0, reason: 'initial', continues: null });
    expect(evs.at(-1)).toEqual({ kind: 'attempt_end', attempt: 0, terminal: 'no_terminal' });
  });

  it.each([{message:interrupt,resume:undefined,partial:false},{message:staleErr,resume:'old',partial:false},{message:interrupt,resume:'old',partial:true},{message:staleErr,resume:'old',partial:true}])('has no recovery attempt/end after $message (partial=$partial)',async({message,resume,partial})=>{
 scriptedRuns=[async function*(){yield started('t');if(partial)yield msg('before','partial');throw new Error(message);}];const seen:AgentOutputEvent[]=[];
 await expect((async()=>{for await(const e of queryAgentEvents('hi',cfg(),undefined,undefined,{resume}))seen.push(e);})()).rejects.toMatchObject({report:{attempts:1,decision:'blocked_uncertain'}});
 expect(seen.map(e=>e.kind)).toEqual(partial?['attempt_start','message']:['attempt_start']);expect(runIdx).toBe(1);
 });





  it('T6: an error after partial output propagates (no attempt_end)', async () => {
    scriptedRuns = [async function* () {
      yield started('t1');
      yield msg('item_0', 'partial');
      yield { type: 'turn.failed', error: { message: 'boom' } };
    }];
    const seen: AgentOutputEvent[] = [];
    await expect((async () => {
      for await (const ev of queryAgentEvents('hi', cfg())) seen.push(ev);
    })()).rejects.toBeInstanceOf(TurnFailure);
    expect(seen.some((e) => e.kind === 'attempt_end')).toBe(false);
  });


});

describe('T14: queryAgent wrapper keeps baseline string output', () => {
  it('yields only the completed run, first-seen order, non-empty, snapshot-overwritten', async () => {
    scriptedRuns = [
      async function* () {
        yield started('t1');
        yield msg('item_0', 'a1', {}, 'updated');
        yield msg('item_1', '');
        yield msg('item_2', 'b');
        yield msg('item_0', 'a2');
        yield turnDone;
      },
    ];
    const out: string[] = [];
    for await (const t of queryAgent('hi', cfg())) out.push(t);
    expect(out).toEqual(['a2', 'b']);
  });
});

describe('T25: one canonical options contract', () => {
  it('queryAgent and queryAgentEvents both take QueryAgentOptions', () => {
    expectTypeOf<NonNullable<Parameters<typeof queryAgent>[4]>>().toEqualTypeOf<QueryAgentOptions>();
    expectTypeOf<NonNullable<Parameters<typeof queryAgentEvents>[4]>>().toEqualTypeOf<QueryAgentOptions>();
    expectTypeOf<Parameters<typeof queryAgent>>().toEqualTypeOf<Parameters<typeof queryAgentEvents>>();
  });

  it('exposes only supported query options', () => {
    expectTypeOf<Extract<keyof QueryAgentOptions, 'onResumeFailed' | 'fallbackRetryPrompt'>>().toEqualTypeOf<never>();
    expectTypeOf<QueryAgentOptions>().toEqualTypeOf<{
      resume?: string;
      onSessionId?: (id: string, prompt: string) => void;
      groupInstructions?: string;
      senderContext?: import('../prompt-safety.js').SafeText;
      signal?: AbortSignal;
      deadline?: number;
      diagnosticId?: string;
      assertPublishable?: () => void;
      onExecutionRisk?: (risk: import('../agent-failure.js').ExecutionRisk) => void;
      onManagedExecution?: (execution: import('../execution-scope.js').ManagedExecution) => void;
      interruptedTurn?: import('../turn-context.js').InterruptedTurn;
    }>();
  });

  it('onSessionId observes the current attempt without a replay callback',async()=>{
 const session=vi.fn();scriptedRuns=[async function*(){yield started('t');yield turnDone;}];
 await events({resume:'t',onSessionId:session});expect(session).toHaveBeenCalledWith('t',expect.stringContaining('hi'));
 });
});
