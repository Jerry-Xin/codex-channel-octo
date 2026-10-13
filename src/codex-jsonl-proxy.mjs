#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

export function escapeJsonlSeparators(text) {
  return text.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function runCodexJsonlProxy(launcher, args) {
  const child = spawn(process.execPath, [launcher, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  const decoder = new StringDecoder('utf8');
  process.stdin.pipe(child.stdin);
  child.stdin.on('error', () => {});
  child.stderr.pipe(process.stderr);
  child.stdout.on('data', (buffer) => {
    if (!process.stdout.write(escapeJsonlSeparators(decoder.write(buffer)))) child.stdout.pause();
  });
  process.stdout.on('drain', () => child.stdout.resume());
  process.stdout.on('error', () => child.kill('SIGTERM'));
  child.stdout.on('end', () => process.stdout.write(escapeJsonlSeparators(decoder.end())));
  const forward = (signal) => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = signals.map((signal) => () => forward(signal));
  signals.forEach((signal, index) => process.on(signal, handlers[index]));
  child.once('error', () => {
    process.stderr.write('Codex JSONL proxy could not start CLI\n');
    process.exitCode = 1;
  });
  child.once('close', (code, signal) => {
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
    signals.forEach((name, index) => process.removeListener(name, handlers[index]));
    if (signal) process.stdout.write('', () => process.kill(process.pid, signal));
    else process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const sdkRequire = createRequire(import.meta.resolve('@openai/codex-sdk'));
    runCodexJsonlProxy(sdkRequire.resolve('@openai/codex/bin/codex.js'), process.argv.slice(2));
  } catch {
    process.stdout.write(JSON.stringify({ type: 'error', message: 'CODEX_JSONL_PROXY_BOOTSTRAP_FAILURE: reinstall dependencies and run npm run build' }) + '\n');
    process.exitCode = 1;
  }
}
