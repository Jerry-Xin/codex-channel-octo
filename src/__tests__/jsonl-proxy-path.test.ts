import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveJsonlProxyPath } from '../jsonl-proxy-path.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'proxy-path-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('proxy availability fallback', () => {
  it('returns no override for missing or non-file artifacts with actionable safe diagnostics', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveJsonlProxyPath(join(root, 'missing'), 'linux')).toBeUndefined();
    expect(JSON.stringify(warning.mock.calls)).toContain('npm run build');
    const directory = join(root, 'directory');
    mkdirSync(directory);
    expect(resolveJsonlProxyPath(directory, 'linux')).toBeUndefined();
    expect(JSON.stringify(warning.mock.calls)).not.toContain(root);
  });
  it.skipIf(process.platform === 'win32')('selects executable artifacts and rejects ones without execute permissions', () => {
    const file = join(root, 'proxy.mjs');
    writeFileSync(file, '', { mode: 0o755 });
    expect(resolveJsonlProxyPath(file, 'linux')).toBe(file);
    chmodSync(file, 0o644);
    expect(resolveJsonlProxyPath(file, 'linux')).toBeUndefined();
  });
  it('keeps Windows on the direct SDK path', () => {
    expect(resolveJsonlProxyPath(join(root, 'missing'), 'win32')).toBeUndefined();
  });
});
