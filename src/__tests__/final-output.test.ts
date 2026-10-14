import { describe, it, expect } from 'vitest';
import { OutputCollector, DEFAULT_OUTPUT_SELECTION_MODE, describeSelection, type OutputSelectionMode } from '../output-selection.js';
import type { AgentOutputEvent, MessagePhase } from '../agent-bridge.js';
const start = (attempt=0,continues:number|null=null):AgentOutputEvent => ({kind:'attempt_start',attempt,reason:continues===null?'initial':'stream_recovery',continues});
const message = (id:string,text:string,seq:number,phase:MessagePhase='unknown',attempt=0):AgentOutputEvent=>({kind:'message',attempt,itemId:id,text,seq,phase});
const end = (attempt=0,terminal:'completed'|'no_terminal'='completed'):AgentOutputEvent=>({kind:'attempt_end',attempt,terminal});
function select(events:AgentOutputEvent[],mode:OutputSelectionMode=DEFAULT_OUTPUT_SELECTION_MODE,maxChars=524288){const c=new OutputCollector();events.forEach(e=>c.push(e));return c.select({mode,maxChars});}
describe('default final selection without SDK phase metadata',()=>{
 it('uses a deterministic last-message fallback, not all unlabeled narration',()=>{
  const result=select([start(),message('p','checking',0),message('f','answer',1),end()]);
  expect(DEFAULT_OUTPUT_SELECTION_MODE).toBe('final');expect(result.text).toBe('answer');expect(result.source).toBe('last_message');expect(result.droppedMessageCount).toBe(1);
  expect(describeSelection(result,'final',1)).toContain('source=last_message');
 });
 it('does not concatenate several unlabeled messages after the last work item',()=>{
  expect(select([start(),{kind:'work',attempt:0,itemId:'w',seq:0,itemType:'command_execution'},message('p','checking result',1),message('f','answer',2),end()]).text).toBe('answer');
 });
 it('replaces snapshots without making an earlier item the final item',()=>{
  const result=select([start(),message('a','old',0),message('b','answer',1),message('a','updated',0),end()]);expect(result.text).toBe('answer');expect(result.messageIds).toEqual(['b']);
 });
 it('keeps the latest snapshot of the selected item',()=>expect(select([start(),message('f','old',0),message('f','answer',0),end()]).text).toBe('answer'));
 it('ignores blank trailing messages and whitespace-only labeled finals',()=>{
  expect(select([start(),message('a','answer',0),message('b',' \n',1),message('f','\t',2,'final_answer'),end()]).text).toBe('answer');
 });
 it('preserves every explicit final part and excludes commentary/partial text',()=>{
  expect(select([start(),message('c','progress',0,'commentary'),message('p','draft',1,'partial_answer'),message('f1','part one',2,'final_answer'),message('f2','part two',3,'final_answer'),end()]).text).toBe('part one\n\npart two');
 });
 it('falls back to only the last commentary when that is all it has',()=>expect(select([start(),message('a','first',0,'commentary'),message('b','last',1,'commentary'),end()]).text).toBe('last'));
 it('does not append commentary emitted after an unknown answer',()=>expect(select([start(),message('a','answer',0),message('b','progress',1,'commentary'),end()]).text).toBe('answer'));
 it('marks no-terminal fallback as partial rather than a proven final',()=>expect(select([start(),message('a','partial',0),end(0,'no_terminal')])).toMatchObject({text:'partial',source:'last_message_partial'}));
 it('uses only the latest useful inherited item when recovery has no output',()=>expect(select([start(),message('a','progress',0),message('b','partial',1),start(1,0),end(1)])).toMatchObject({text:'partial',pool:'lineage',source:'last_message_partial'}));
 it('does not let a whitespace-only recovery hide useful inherited output',()=>expect(select([start(),message('a','partial',0),start(1,0),message('blank',' \n',1,'unknown',1),end(1)])).toMatchObject({text:'partial',pool:'lineage',source:'last_message_partial'}));
 it('does not pull output from a stale attempt into an unrelated fresh attempt',()=>expect(select([start(),message('a','old',0),start(1),end(1)]).text).toBe(''));
 it('caps only the selected fallback and does not expose excluded text',()=>{const result=select([start(),message('p','PRIVATE PROGRESS',0),message('f','answer'.repeat(30),1),end()],'final',50);expect(result.text.length).toBe(50);expect(result.text).not.toContain('PRIVATE');});
 it('retains explicit phase and legacy compatibility modes',()=>{
  const events=[start(),message('a','one',0),message('b','two',1),end()];expect(select(events,'phase').text).toBe('one\n\ntwo');expect(select(events,'legacy').text).toBe('onetwo');
 });
});
