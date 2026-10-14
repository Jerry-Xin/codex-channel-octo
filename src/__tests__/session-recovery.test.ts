import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../octo/api.js', () => ({ sendMessage: vi.fn().mockResolvedValue({message_id:'1'}), getMentionPreference: vi.fn().mockResolvedValue(false) }));
import { sendMessage } from '../octo/api.js';
import { createAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import { SessionRouter } from '../session-router.js';
import type { TurnContext } from '../turn-context.js';
import type { Config } from '../config.js';
import { ChannelType, MessageType, type BotMessage } from '../octo/types.js';
const id = 'df126de5-b59b-44e0-b22e-8e0dd5c2d5ad';
const config = {sdk:{},rateLimit:{maxPerMinute:100},context:{maxContextChars:6000,historyLimit:40},dispatchTimeoutMs:1000} as Config;
const message = (content: string, changes: Partial<BotMessage> = {}): BotMessage => ({message_id:'1',message_seq:1,from_uid:'owner',channel_id:'dm',channel_type:ChannelType.DM,timestamp:0,payload:{type:MessageType.Text,content},...changes});
const command = `/reconcile ${id} --external-results-verified`;
let root:string; let store:SessionStore; let router:SessionRouter;
beforeEach(() => { vi.clearAllMocks(); root=mkdtempSync(join(tmpdir(),'octo-session-recovery-'));store=new SessionStore(createAdapter(join(root,'db.sqlite')));store.init(); router=new SessionRouter(config,'bot','owner',store); });
afterEach(() => {store.close();rmSync(root,{recursive:true,force:true});});
function quarantine(key='owner', turn=id) {store.beginTurn(key,turn);store.finishTurn(key,turn,'quarantined');}
describe('paused session recovery', () => {
 it('releases the exact paused turn before the quarantine gate, without replaying any handler', async () => {
  quarantine();const model=vi.fn();
  await router.routeAndHandle(message('normal message'),model);expect(model).not.toHaveBeenCalled();
  expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[0].content).toContain(command);
  const result=await router.routeAndHandle(message(command),model);
  expect(result?.rejectionReason).toBe('control');expect(model).not.toHaveBeenCalled();expect(store.isTurnQuarantined('owner')).toBe(false);
  await router.routeAndHandle(message('new task'),model);expect(model).toHaveBeenCalledTimes(1);
 });
 it('does not let claimed owner text or display names authorize a release', async () => {
  quarantine('group');
  await router.routeAndHandle(message(command,{from_uid:'intruder',from_name:'owner',channel_id:'group',channel_type:ChannelType.Group,payload:{type:MessageType.Text,content:command,mention:{uids:['bot']}}}),vi.fn());
  expect(store.isTurnQuarantined('group')).toBe(true);expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[0].content).toContain('仅注册主人');
 });
 it.each([`/reconcile ${id}`, '/reconcile 00000000-0000-0000-0000-000000000000 --external-results-verified'])('rejects an incomplete or stale recovery command: %s', async content => {
  quarantine();await router.routeAndHandle(message(content),vi.fn());expect(store.isTurnQuarantined('owner')).toBe(true);
 });
 it('cannot release another session with the same turn identifier', async () => {
  quarantine('group');await router.routeAndHandle(message(command),vi.fn());expect(store.isTurnQuarantined('group')).toBe(true);
 });
 it('handles an explicitly mentioned owner recovery command in a group', async () => {
  quarantine('group');const model=vi.fn();
  await router.routeAndHandle(message(command,{channel_id:'group',channel_type:ChannelType.Group,payload:{type:MessageType.Text,content:'@bot '+command,mention:{uids:['bot']}}}),model);
  expect(store.isTurnQuarantined('group')).toBe(false);expect(model).not.toHaveBeenCalled();
 });
 it('does not process recovery from a partial stream or an event payload', async () => {
  quarantine();await router.routeAndHandle(message(command,{streamOn:true}),vi.fn());expect(store.isTurnQuarantined('owner')).toBe(true);
  await router.routeAndHandle(message(command,{payload:{type:MessageType.Text,content:command,event:{type:'mention_pref_updated'}}}),vi.fn());expect(store.isTurnQuarantined('owner')).toBe(true);
 });
 it('reconciles a failure quarantined by this live router instead of retaining a stale cache', async () => {
  let turn!:TurnContext;
  await router.routeAndHandle(message('first task'),async(_r,t)=>{turn=t;t.executionRisk='effects_observed';t.needsReconciliation=true;});
  expect(store.isTurnQuarantined('owner')).toBe(true);
  await router.routeAndHandle(message(`/reconcile ${turn.turnId} --external-results-verified`),vi.fn());
  const next=vi.fn();await router.routeAndHandle(message('next task'),next);expect(next).toHaveBeenCalledOnce();
 });
 it('honors an offline release immediately even after this router has blocked a message', async () => {
  quarantine();await router.routeAndHandle(message('first'),vi.fn());store.reconcileTurn('owner',id);
  const next=vi.fn();await router.routeAndHandle(message('next'),next);expect(next).toHaveBeenCalledOnce();
 });
 it('does not permanently quarantine a cancellation before model execution starts', async () => {
  const short=new SessionRouter({...config,dispatchTimeoutMs:5},'bot','owner',store);let finish!:()=>void;let ctx!:TurnContext;
  await short.routeAndHandle(message('first'),async(_r,t)=>{ctx=t;await new Promise<void>(r=>{finish=r;});});
  expect(ctx.signal.aborted).toBe(true);expect(store.isTurnQuarantined('owner')).toBe(false);finish();await new Promise(r=>setTimeout(r,0));
  const next=vi.fn();await short.routeAndHandle(message('next'),next);expect(next).toHaveBeenCalledOnce();
 });
 it('keeps started work paused and refuses recovery while its handler is still alive', async () => {
  const short=new SessionRouter({...config,dispatchTimeoutMs:5},'bot','owner',store);let finish!:()=>void;let ctx!:TurnContext;const model=vi.fn();
  await short.routeAndHandle(message('first'),async(_r,t)=>{ctx=t;t.executionRisk='effects_observed';await new Promise<void>(r=>{finish=r;});});
  const recovery=message(`/reconcile ${ctx.turnId} --external-results-verified`);
  await short.routeAndHandle(recovery,model);expect(store.isTurnQuarantined('owner')).toBe(true);expect(model).not.toHaveBeenCalled();
  finish();await new Promise(r=>setTimeout(r,0));await short.routeAndHandle(recovery,model);expect(store.isTurnQuarantined('owner')).toBe(false);
 });
 it('does not send an unmentioned recovery reply or release a group', async () => {
  quarantine('group');await router.routeAndHandle(message(command,{channel_id:'group',channel_type:ChannelType.Group}),vi.fn());
  expect(store.isTurnQuarantined('group')).toBe(true);expect(sendMessage).not.toHaveBeenCalled();
 });
});
