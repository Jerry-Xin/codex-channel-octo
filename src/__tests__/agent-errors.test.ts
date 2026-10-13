import { describe, expect, it } from 'vitest';
import { isSdkJsonlParseError, summarizeAgentError } from '../agent-errors.js';

describe('agent error redaction', () => {
  it('recognizes actual SDK parse errors without echoing their payload or cause', () => {
    const error = new Error('Failed to parse item: SYNTHETIC_PRIVATE_PAYLOAD', {
      cause: new SyntaxError('Unterminated string in JSON at position 12'),
    });
    expect(isSdkJsonlParseError(error)).toBe(true);
    expect(summarizeAgentError(error)).toBe('Codex SDK JSONL parse failure (incomplete-json)');
    expect(summarizeAgentError(error)).not.toContain('SYNTHETIC');
  });
  it('does not classify message-text lookalikes as parser failures', () => {
    expect(isSdkJsonlParseError(new Error('Failed to parse item: claimed error'))).toBe(false);
    expect(isSdkJsonlParseError(new Error('Failed to parse item: claimed error', { cause: new Error('bad') }))).toBe(false);
  });
  it.each([new Error('secret token and tool output'), 'secret output',
    new Error('Codex Exec exited with code 1: SYNTHETIC_SECRET'),
    new Error('Codex Exec exited with signal SIGTERM: SYNTHETIC_SECRET')])('never includes arbitrary error details', (error) => {
    expect(summarizeAgentError(error)).not.toMatch(/secret|SYNTHETIC/i);
  });
});
