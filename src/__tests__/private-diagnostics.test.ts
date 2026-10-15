import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rememberSdkFailure, inheritSdkDiagnostic, privateDiagnosticRow, recordPrivateFailure } from '../private-diagnostics.js';
import { AgentFailure, TurnFailure, failureReply, type FailureReport } from '../agent-failure.js';
import { recover } from '../agent-recovery.js';
let root:string;
const id='3f8d62cf-fca8-4e92-a0a0-cdb5db5c6ab2';
const report:FailureReport={diagnosticId:id,attempts:1,decision:'blocked_uncertain',executionRisk:'effects_observed',first:{stage:'inference',category:'unknown',source:'sdk_event',evidence:'unknown'},final:{stage:'inference',category:'unknown',source:'sdk_event',evidence:'unknown'}};
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'private-diagnostics-'));});
afterEach(()=>{rmSync(root,{recursive:true,force:true});});
function read():Record<string,unknown> {return JSON.parse(readFileSync(join(root,'diagnostics/agent-failures.jsonl'),'utf8').trim());}
describe('opt-in private diagnostics',()=>{
 it('does not create anything when disabled',()=>{expect(recordPrivateFailure(root,false,report,new Error('PRIVATE'))).toBe(true);expect(readdirSync(root)).toEqual([]);});
 it.each(['item.error','turn.failed','error','exception'] as const)('fingerprints %s without retaining or publishing SDK text',event=>{
  const original=new AgentFailure(report.final);const privateText='PRIVATE_PROMPT bf_TOKEN sk-KEY Bearer AUTH https://private.example/?token=SECRET';rememberSdkFailure(original,event,privateText);
  const wrapped=inheritSdkDiagnostic(new TurnFailure(report),original);expect(recordPrivateFailure(root,true,report,wrapped)).toBe(true);
  const raw=JSON.stringify(read());expect(raw).not.toMatch(/PRIVATE_PROMPT|bf_TOKEN|sk-KEY|AUTH|private.example|SECRET/);expect(raw).toContain(createHash('sha256').update(privateText).digest('hex'));
  expect(JSON.stringify(wrapped)).not.toContain('fingerprint');expect(failureReply(report)).not.toContain('fingerprint');
 });
 it('preserves the actual SDK event over later generic exception wrapping',()=>{
  const error=new AgentFailure(report.final);rememberSdkFailure(error,'turn.failed','original');rememberSdkFailure(error,'exception',error.message);
  expect(privateDiagnosticRow(report,error)).toMatchObject({sdk:{event:'turn.failed',fingerprint:createHash('sha256').update('original').digest('hex')}});
 });
 it('returns an isolated metadata snapshot rather than exposing mutable provenance',()=>{
  const error=new Error('PRIVATE');rememberSdkFailure(error,'turn.failed',error.message);
  const row=privateDiagnosticRow(report,error) as {sdk:{event:string}};row.sdk.event='PRIVATE_MUTATION';
  expect(privateDiagnosticRow(report,error)).toMatchObject({sdk:{event:'turn.failed'}});
 });
 it('bounds fingerprints of long errors and never records their tail',()=>{
  const error=new Error('UNRECOGNIZED');const text='x'.repeat(8192)+'PRIVATE_TAIL';rememberSdkFailure(error,'error',text);
  expect(privateDiagnosticRow(report,error)).toMatchObject({sdk:{fingerprintTruncated:true,messageBytes:Buffer.byteLength(text),fingerprint:createHash('sha256').update('x'.repeat(8192)).digest('hex')}});
  expect(JSON.stringify(privateDiagnosticRow(report,error))).not.toContain('PRIVATE_TAIL');
 });
 it('allows only known OS codes and closed snapshot fields',()=>{
  const error=Object.assign(new Error('PRIVATE'),{code:'PRIVATE_CODE'});rememberSdkFailure(error,'exception',error.message);
  const unsafe={...report,first:{...report.first,rawBody:'PRIVATE_BODY',category:'PRIVATE_CATEGORY',httpStatus:9999,retryAfterMs:Infinity},stack:'PRIVATE_STACK'} as unknown as FailureReport;
  const row=JSON.stringify(privateDiagnosticRow(unsafe,error));expect(row).not.toMatch(/PRIVATE_CODE|PRIVATE_BODY|PRIVATE_CATEGORY|PRIVATE_STACK|9999/);
  const known=Object.assign(new Error('PRIVATE'),{code:'EAGAIN'});rememberSdkFailure(known,'exception',known.message);expect(privateDiagnosticRow(report,known)).toMatchObject({sdk:{code:'EAGAIN'}});
 });
 it('retains diagnostics through the real recovery wrapper without changing retry eligibility',async()=>{
  let calls=0,caught:unknown;
  try {for await(const value of recover(async function*(){calls++;const e=new AgentFailure(report.final);rememberSdkFailure(e,'error','PRIVATE');throw e;yield '';},{id,risk:()=> 'effects_observed',config:{enabled:true}}))void value;}catch(error){caught=error;}
  expect(calls).toBe(1);expect(caught).toBeInstanceOf(TurnFailure);expect(privateDiagnosticRow(report,caught)).toMatchObject({sdk:{event:'error'}});expect(JSON.stringify(caught)).not.toContain('PRIVATE');
 });
 it('never emits raw exception text, stack or cause',()=>{
  const error=new Error('PRIVATE_EXCEPTION_TEXT',{cause:new Error('PRIVATE_CAUSE_TEXT')});rememberSdkFailure(error,'exception',error.message);
  const encoded=JSON.stringify(privateDiagnosticRow(report,error));expect(encoded).not.toMatch(/PRIVATE_EXCEPTION_TEXT|PRIVATE_CAUSE_TEXT|stack|cause/);
 });
 it('creates owner-only files and directories',()=>{
  expect(recordPrivateFailure(root,true,report,new Error('PRIVATE'))).toBe(true);
  expect(statSync(join(root,'diagnostics')).mode&0o777).toBe(0o700);expect(statSync(join(root,'diagnostics/agent-failures.jsonl')).mode&0o777).toBe(0o600);
 });
 it('rotates before exceeding the size bound and retains only the bounded files',()=>{
  for(let i=0;i<30;i++)expect(recordPrivateFailure(root,true,{...report,attempts:i},new Error('PRIVATE'),{maxBytes:1024,maxFiles:3})).toBe(true);
  const dir=join(root,'diagnostics');const files=readdirSync(dir);expect(files.sort()).toEqual(['agent-failures.jsonl','agent-failures.jsonl.1','agent-failures.jsonl.2']);
  for(const file of files){expect(statSync(join(dir,file)).size).toBeLessThanOrEqual(1024);for(const line of readFileSync(join(dir,file),'utf8').trim().split('\n'))expect(JSON.parse(line)).toHaveProperty('diagnosticId',id);}
 });
 it('leaves existing records intact when disabled later',()=>{
  recordPrivateFailure(root,true,report,new Error('PRIVATE'));const before=readFileSync(join(root,'diagnostics/agent-failures.jsonl'),'utf8');recordPrivateFailure(root,false,report,new Error('OTHER'));expect(readFileSync(join(root,'diagnostics/agent-failures.jsonl'),'utf8')).toBe(before);
 });
 it('rejects bad IDs, invalid bounds and an unwritable destination without throwing',()=>{
  expect(recordPrivateFailure(root,true,{...report,diagnosticId:'PRIVATE_ID'},new Error('PRIVATE'))).toBe(false);
  expect(recordPrivateFailure(root,true,report,new Error('PRIVATE'),{maxBytes:0,maxFiles:100})).toBe(false);
  const file=join(root,'not-a-directory');writeFileSync(file,'KEEP');expect(recordPrivateFailure(file,true,report,new Error('PRIVATE'))).toBe(false);expect(readFileSync(file,'utf8')).toBe('KEEP');
 });
 it.each([false,true])('rejects a symlink log, including dangling=%s',dangling=>{
  const dir=join(root,'diagnostics');mkdirSync(dir);const target=join(root,'outside');if(!dangling)writeFileSync(target,'KEEP');symlinkSync(target,join(dir,'agent-failures.jsonl'));
  expect(recordPrivateFailure(root,true,report,new Error('PRIVATE'))).toBe(false);if(!dangling)expect(readFileSync(target,'utf8')).toBe('KEEP');
 });
 it('rejects a symlink directory without writing through it',()=>{
  const target=join(root,'outside');mkdirSync(target);symlinkSync(target,join(root,'diagnostics'));expect(recordPrivateFailure(root,true,report,new Error('PRIVATE'))).toBe(false);expect(readdirSync(target)).toEqual([]);
 });
 it('does not modify an oversized pre-existing file',()=>{
  const dir=join(root,'diagnostics');mkdirSync(dir);const file=join(dir,'agent-failures.jsonl');writeFileSync(file,'x'.repeat(2048));expect(recordPrivateFailure(root,true,report,new Error('PRIVATE'),{maxBytes:1024,maxFiles:3})).toBe(false);expect(statSync(file).size).toBe(2048);
 });
});
