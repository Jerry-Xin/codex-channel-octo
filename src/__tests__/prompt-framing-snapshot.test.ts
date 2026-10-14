/**
 * T26 — prompt framing snapshot. The strings passed to `runStreamed` for the
 * initial, stream-recovery and stale-resume fresh-retry attempts must stay
 * byte-identical to the pre-output-selection bridge. The digests below were
 * recorded from the baseline bridge (upstream main c66504e, after sender-context framing) with this same
 * script; any edit to the framing changes them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

type Ev = Record<string, unknown>;
let scriptedRuns: Array<() => AsyncGenerator<Ev>>;
let runIdx: number;
const prompts: string[] = [];

function makeThread() {
  return {
    async runStreamed(prompt: string) {
      prompts.push(prompt);
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

import { queryAgent } from '../agent-bridge.js';
import type { Config } from '../config.js';

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

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const interrupt = 'stream disconnected before completion: stream closed before response.completed';

beforeEach(() => {
  runIdx = 0;
  scriptedRuns = [];
  prompts.length = 0;
});

async function drain(opts?: Parameters<typeof queryAgent>[4]): Promise<void> {
  for await (const t of queryAgent('USER BODY', cfg(), undefined, undefined, opts)) void t;
}

describe('T26: prompt framing is byte-identical to baseline', () => {
  it('initial → stale-resume fresh retry → stream recovery', async () => {
    scriptedRuns = [
      async function* () {
        throw new Error('thread not found');
      },
      async function* () {
        yield { type: 'thread.started', thread_id: 't2' };
        throw new Error(interrupt);
      },
      async function* () {
        yield { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'ok' } };
        yield { type: 'turn.completed', usage: {} };
      },
    ];
    await drain({ resume: 'old', fallbackRetryPrompt: 'FALLBACK BODY', onResumeFailed: () => {} });
    expect(prompts).toHaveLength(3);
    const [initial, fresh, recovery] = prompts;
    expect(initial.endsWith('\n\n---\n\n[Current message — respond to this ONLY]\nUSER BODY')).toBe(true);
    expect(fresh.endsWith('\n\n---\n\n[Current message — respond to this ONLY]\nFALLBACK BODY')).toBe(true);
    expect(recovery.endsWith('\n\n---\n\n[Current message — respond to this ONLY]\n上次回复因连接中断未完成。请基于你已经完成的工作，直接继续并给出最终结论，不要重复已执行过的步骤。')).toBe(true);
    expect([sha(initial), sha(fresh), sha(recovery)]).toEqual([
      // Current-turn mention schema and its security framing are additive.
      'c8b89ebc603df552b44174bc43110af1ff3f5e63403355d8251cac8565227dc5',
      'd91de055e6949c78c268b2944a00f293db4994f83ee39d7a84c79f7867d1db98',
      'a638533c16eb4b0f86b4764c51272ce3b840156315b5b3a800037461361eab0f',
    ]);
  });

  it('fresh retry without a fallback prompt reuses the initial prompt', async () => {
    scriptedRuns = [
      async function* () {
        throw new Error('thread not found');
      },
      async function* () {
        yield { type: 'turn.completed', usage: {} };
      },
    ];
    await drain({ resume: 'old', onResumeFailed: () => {} });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe(prompts[0]);
  });
});
