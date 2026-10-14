#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { realpathSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

function acknowledgeStopped() {
  const directory = process.env.CODEX_CHANNEL_EXECUTION_DIR;
  const token = process.env.CODEX_CHANNEL_EXECUTION_TOKEN;
  if (!directory || !token) return;
  try {
    const temporary = join(directory, `status-${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify({ token, state: 'stopped' }), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, join(directory, 'status.json'));
  } catch { /* Missing proof keeps the session blocked; no raw diagnostics. */ }
}

// Only inspect/signal the group created by this proxy, never the gateway group.
function groupStopped(pid) {
  if (!pid) return true;
  if (process.platform === 'win32') return false;
  try {
    const rows = execFileSync('/bin/ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', timeout: 1000 });
    return !rows.split('\n').some(row => {
      const [group, state] = row.trim().split(/\s+/);
      return Number(group) === pid && state && !state.startsWith('Z');
    });
  } catch { return false; }
}

export function escapeJsonlSeparators(text) {
  return text.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function runCodexJsonlProxy(launcher, args) {
  const env = { ...process.env };
  // Neither credentials for teardown nor its control path reach model tools.
  delete env.CODEX_CHANNEL_EXECUTION_DIR;
  delete env.CODEX_CHANNEL_EXECUTION_TOKEN;
  const child = spawn(process.execPath, [launcher, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'], env, detached: process.platform !== 'win32',
  });
  const decoder = new StringDecoder('utf8');
  let cancelled = false;
  let terminationTimer;
  const signalGroup = signal => {
    try {
      if (process.platform === 'win32') child.kill(signal);
      else if (!groupStopped(child.pid)) process.kill(-child.pid, signal);
    } catch { /* The close/proof path determines whether teardown succeeded. */ }
  };
  process.stdin.pipe(child.stdin);
  child.stdin.on('error', () => {});
  child.stderr.pipe(process.stderr);
  child.stdout.on('data', (buffer) => {
    if (!cancelled && !process.stdout.write(escapeJsonlSeparators(decoder.write(buffer)))) child.stdout.pause();
  });
  process.stdout.on('drain', () => child.stdout.resume());
  process.stdout.on('error', () => forward('SIGTERM'));
  child.stdout.on('end', () => { if (!cancelled) process.stdout.write(escapeJsonlSeparators(decoder.end())); });
  const forward = (signal) => {
    cancelled = true;
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
    child.stdin.destroy();
    child.stdout.resume();
    child.stderr.unpipe(process.stderr);
    child.stderr.resume();
    signalGroup(signal);
    if (!terminationTimer) terminationTimer = setTimeout(() => {
      signalGroup('SIGKILL');
      terminationTimer = setTimeout(() => process.exit(1), 500);
    }, 1500);
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = signals.map((signal) => () => forward(signal));
  signals.forEach((signal, index) => process.on(signal, handlers[index]));
  child.once('error', () => {
    process.stderr.write('Codex JSONL proxy could not start CLI\n');
    process.exitCode = 1;
  });
  child.once('close', async (code, signal) => {
    clearTimeout(terminationTimer);
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
    signals.forEach((name, index) => process.removeListener(name, handlers[index]));
    // A failed/cancelled parent may leave children with redirected stdio. Drain
    // those owned processes too before acknowledging interruption cleanup.
    if (cancelled || code !== 0 || signal) {
      signalGroup('SIGTERM');
      const deadline = Date.now() + 1500;
      while (!groupStopped(child.pid) && Date.now() < deadline) await sleep(25);
      if (!groupStopped(child.pid)) signalGroup('SIGKILL');
      const killDeadline = Date.now() + 500;
      while (!groupStopped(child.pid) && Date.now() < killDeadline) await sleep(25);
    }
    if (groupStopped(child.pid)) acknowledgeStopped();
    if (cancelled) {
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 1);
    }
    else if (signal) process.stdout.write('', () => process.kill(process.pid, signal));
    else process.exitCode = code ?? 1;
  });
}

export function startCodexJsonlProxy(args = process.argv.slice(2)) {
  try {
    const sdkRequire = createRequire(import.meta.resolve('@openai/codex-sdk'));
    runCodexJsonlProxy(sdkRequire.resolve('@openai/codex/bin/codex.js'), args);
  } catch {
    acknowledgeStopped(); // Bootstrap failed before any CLI process was started.
    process.stdout.write(JSON.stringify({ type: 'error', message: 'CODEX_JSONL_PROXY_BOOTSTRAP_FAILURE: reinstall dependencies and run npm run build' }) + '\n');
    process.exitCode = 1;
  }
}

try {
  if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) startCodexJsonlProxy();
} catch {
  process.exitCode = 1;
}
