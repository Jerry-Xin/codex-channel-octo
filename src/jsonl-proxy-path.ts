import { accessSync, constants, statSync } from 'node:fs';

let warned = false;

export function resolveJsonlProxyPath(path: string, platform = process.platform): string | undefined {
  if (platform === 'win32') return undefined;
  try {
    if (!statSync(path).isFile()) throw new Error('Not a proxy file');
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    if (!warned) {
      warned = true;
      console.warn('[codex-channel-octo] JSONL proxy missing or not executable; run npm run build; falling back to direct SDK launch (Unicode workaround unavailable).');
    }
    return undefined;
  }
}
