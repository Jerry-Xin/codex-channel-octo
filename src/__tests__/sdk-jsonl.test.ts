import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Codex } from '@openai/codex-sdk';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSdkJsonlParseError, summarizeAgentError } from '../agent-errors.js';

let root: string;
const fixture = fileURLToPath(new URL('./fixtures/jsonl-cli.mjs', import.meta.url));
const proxy = fileURLToPath(new URL('./fixtures/jsonl-proxy.mjs', import.meta.url));
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'sdk-jsonl-')); chmodSync(fixture, 0o755); chmodSync(proxy, 0o755); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(process.platform === 'win32')('real SDK JSONL transport with a synthetic CLI', () => {
  it('accepts large valid JSON containing Unicode separators and split UTF-8 chunks', async () => {
    const sdk = new Codex({ codexPathOverride: proxy, env: { PATH: process.env.PATH!, JSONL_FIXTURE_MODE: 'valid' } });
    const { events } = await sdk.startThread().runStreamed('synthetic prompt');
    const types: string[] = [];
    for await (const event of events) {
      types.push(event.type);
      if (event.type === 'item.completed' && event.item.type === 'command_execution') {
        expect(event.item.aggregated_output).toBe('synthetic\r\n\v\f\u0085\u2028\u2029'.repeat(20_000));
      }
    }
    expect(types).toEqual(['thread.started', 'item.completed', 'turn.completed']);
  });
  it('detects the active runtime’s Unicode readline behavior without real private content', async () => {
    const { createInterface } = await import('node:readline');
    const { Readable } = await import('node:stream');
    const text = JSON.stringify({ content: 'synthetic\u2028\u2029' });
    const records: string[] = [];
    for await (const line of createInterface({ input: Readable.from([text + '\n']), crlfDelay: Infinity })) records.push(line);
    expect(records.join('')).not.toContain('\n');
    if (records.length > 1) expect(() => JSON.parse(records[0])).toThrow(SyntaxError);
    else expect(JSON.parse(records[0]).content).toBe('synthetic\u2028\u2029');
  });
  it('reproduces a truncated record error and confirms SDK cleanup terminates its child', async () => {
    const terminated = join(root, 'terminated');
    const sdk = new Codex({ codexPathOverride: proxy, env: { PATH: process.env.PATH!,
      JSONL_FIXTURE_MODE: 'malformed', JSONL_TERMINATED_FILE: terminated } });
    const { events } = await sdk.startThread().runStreamed('synthetic prompt');
    let failure: unknown;
    try { for await (const event of events) void event; } catch (error) { failure = error; }
    expect(isSdkJsonlParseError(failure)).toBe(true);
    expect(summarizeAgentError(failure)).toBe('Codex SDK JSONL parse failure (incomplete-json)');
    for (let attempt = 0; attempt < 100 && !existsSync(terminated); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(terminated)).toBe(true);
  });
});
