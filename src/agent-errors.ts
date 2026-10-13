export function isSdkJsonlParseError(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith('Failed to parse item:')
    && error.cause instanceof SyntaxError;
}

export function summarizeAgentError(error: unknown): string {
  if (isSdkJsonlParseError(error)) {
    const cause = (error.cause as SyntaxError).message;
    const category = /Unterminated string|Unexpected end of JSON/i.test(cause) ? 'incomplete-json' : 'invalid-json';
    return `Codex SDK JSONL parse failure (${category})`;
  }
  if (error instanceof Error) {
    const exit = /^Codex Exec exited with (signal SIG[A-Z]+|code \d+):/.exec(error.message);
    if (exit) return `Codex process exited with ${exit[1]}`;
    if (/stream closed before response\.completed|stream disconnected before completion/i.test(error.message)) {
      return 'Codex response stream interrupted';
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') return `Agent operation failed (${code})`;
  }
  return 'Agent operation failed (details withheld)';
}
