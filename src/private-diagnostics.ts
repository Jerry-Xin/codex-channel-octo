import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSystemErrorMap } from 'node:util';
import type { FailureReport, FailureSnapshot, FailureStage, FailureCategory } from './agent-failure.js';

export type DiagnosticEvent = 'item.error' | 'turn.failed' | 'error' | 'exception';
interface SdkContext { event: DiagnosticEvent; fingerprint: string; messageBytes: number; fingerprintTruncated: boolean; code?: string; }
const contexts = new WeakMap<Error, SdkContext>();
const systemCodes = new Set([...getSystemErrorMap().values()].map(([code]) => code));
const stages: Record<FailureStage, true> = { prepare:true, spawn:true, inference:true, jsonl_parse:true, process_exit:true, delivery:true, history_commit:true, cleanup:true };
const categories: Record<FailureCategory, true> = { network_transient:true, stream_interrupted:true, rate_limited:true, quota_exhausted:true, provider_unavailable:true, auth:true, permission:true, context_limit:true, invalid_encrypted_content:true, invalid_config:true, jsonl_incomplete:true, jsonl_invalid:true, proxy_bootstrap:true, process_exit:true, cancelled:true, timeout:true, delivery_failed:true, history_failed:true, unknown:true };
const sources: Record<FailureSnapshot['source'], true> = { sdk_event:true, sdk_exception:true, octo_api:true, local:true };
const evidence: Record<FailureSnapshot['evidence'], true> = { structured:true, recognized_text:true, unknown:true };

/** Hash, rather than retain, arbitrary SDK text: it may embed private payloads. */
export function rememberSdkFailure(error: Error, event: DiagnosticEvent, message: unknown): void {
  if (contexts.has(error)) return;
  if (typeof message !== 'string' || !['item.error','turn.failed','error','exception'].includes(event)) return;
  const bounded = message.slice(0, 8192);
  const code = (error as NodeJS.ErrnoException).code;
  contexts.set(error, { event, fingerprint:createHash('sha256').update(bounded).digest('hex'), messageBytes:Buffer.byteLength(message), fingerprintTruncated:message.length > bounded.length,
    ...(typeof code === 'string' && systemCodes.has(code) ? {code} : {}) });
}

/** WeakMap provenance is never serialized with public errors. */
export function inheritSdkDiagnostic<T extends Error>(target: T, source: unknown): T {
  if (source instanceof Error) { const context = contexts.get(source); if (context) contexts.set(target, context); }
  return target;
}

function snapshot(value: FailureSnapshot): FailureSnapshot {
  return { stage:Object.hasOwn(stages,value.stage) ? value.stage : 'inference', category:Object.hasOwn(categories,value.category) ? value.category : 'unknown',
    source:Object.hasOwn(sources,value.source) ? value.source : 'local', evidence:Object.hasOwn(evidence,value.evidence) ? value.evidence : 'unknown',
    ...(Number.isInteger(value.httpStatus) && value.httpStatus! >= 100 && value.httpStatus! <= 599 ? {httpStatus:value.httpStatus} : {}),
    ...(Number.isSafeInteger(value.retryAfterMs) && value.retryAfterMs! >= 0 ? {retryAfterMs:value.retryAfterMs} : {}) };
}

export const PRIVATE_DIAGNOSTIC_LIMITS = { maxBytes:1_048_576, maxFiles:3 } as const;
export function privateDiagnosticRow(report: FailureReport, error: unknown): object | undefined {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(report.diagnosticId)) return;
  return { diagnosticId:report.diagnosticId, timestamp:new Date().toISOString(), first:snapshot(report.first), final:snapshot(report.final),
    attempts:Number.isSafeInteger(report.attempts) && report.attempts >= 0 ? report.attempts : 0,
    decision:['not_attempted','blocked_uncertain','exhausted','cancelled','fresh_retried'].includes(report.decision) ? report.decision : 'not_attempted',
    executionRisk:['proven_not_started','effects_observed','unknown'].includes(report.executionRisk) ? report.executionRisk : 'unknown',
    node:process.version, ...(error instanceof Error && contexts.has(error) ? {sdk:{...contexts.get(error)}} : {}) };
}

/** Local-only bounded metadata; no messages, stack, cause, JSONL, or tool output. */
export function recordPrivateFailure(dataDir: string, enabled: boolean, report: FailureReport, error: unknown,
  limits: {maxBytes:number; maxFiles:number} = PRIVATE_DIAGNOSTIC_LIMITS): boolean {
  if (!enabled) return true;
  try {
    if (!Number.isInteger(limits.maxBytes) || limits.maxBytes < 256 || limits.maxBytes > PRIVATE_DIAGNOSTIC_LIMITS.maxBytes
      || !Number.isInteger(limits.maxFiles) || limits.maxFiles < 1 || limits.maxFiles > PRIVATE_DIAGNOSTIC_LIMITS.maxFiles) return false;
    const row = privateDiagnosticRow(report,error); if (!row) return false;
    const line = JSON.stringify(row) + '\n'; if (Buffer.byteLength(line) > Math.min(limits.maxBytes,16_384)) return false;
    const dir = join(dataDir,'diagnostics');
    if (existsSync(dir) && (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink())) return false;
    mkdirSync(dir,{recursive:true,mode:0o700}); chmodSync(dir,0o700);
    const file = join(dir,'agent-failures.jsonl');
    for (let i=0; i<limits.maxFiles; i++) {
      const path = i===0 ? file : `${file}.${i}`;
      const existing = lstatSync(path, {throwIfNoEntry:false});
      if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.size > limits.maxBytes)) return false;
    }
    if (existsSync(file) && lstatSync(file).size + Buffer.byteLength(line) > limits.maxBytes) {
      const last = limits.maxFiles===1 ? file : `${file}.${limits.maxFiles-1}`;
      if (existsSync(last)) unlinkSync(last);
      for (let i=limits.maxFiles-2; i>=0; i--) {
        const from = i===0 ? file : `${file}.${i}`;
        if (existsSync(from)) renameSync(from,`${file}.${i+1}`);
      }
    }
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { fchmodSync(fd,0o600); writeFileSync(fd,line); } finally { closeSync(fd); }
    return true;
  } catch { return false; }
}
