import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../octo/api.js', () => ({ sendMessage: vi.fn().mockResolvedValue({message_id:'1'}), getMentionPreference: vi.fn().mockResolvedValue(false) }));
import { sendMessage } from '../octo/api.js';
import { createAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import { SessionRouter } from '../session-router.js';
import { isOwnerSender } from '../sender-context.js';
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
 it.each(['sPUB_owner', 'sEVIL_owner'])('rejects a suffix-only owner alias not bound by registration (%s)', async sender => {
  const group = sender.replace('owner', 'group');
  quarantine(group);
  await router.routeAndHandle(message(command, { from_uid: sender, channel_id: group, channel_type: ChannelType.Group,
    payload: { type: MessageType.Text, content: command, mention: { uids: ['bot'] } } }), vi.fn());
  expect(store.isTurnQuarantined(group)).toBe(true);
 });
 it('accepts the single prefixed identity bound by the registration channel, and rejects other spaces', async () => {
  const scoped = new SessionRouter(config, 'bot', 'owner', store, 'sPUB_owner@sPUB_bot');
  quarantine(scoped.sessionKey(message(command, { from_uid: 'sPUB_owner', channel_id: 'sPUB_owner@sPUB_bot' })));
  await scoped.routeAndHandle(message(command, { from_uid: 'sPUB_owner', channel_id: 'sPUB_owner@sPUB_bot' }), vi.fn());
  expect(store.isTurnQuarantined(scoped.sessionKey(message(command, { from_uid: 'sPUB_owner', channel_id: 'sPUB_owner@sPUB_bot' })))).toBe(false);
  quarantine(scoped.sessionKey(message(command, { from_uid: 'sEVIL_owner', channel_id: 'sEVIL_owner@sEVIL_bot' })));
  await scoped.routeAndHandle(message(command, { from_uid: 'sEVIL_owner', channel_id: 'sEVIL_owner@sEVIL_bot' }), vi.fn());
  expect(store.isTurnQuarantined(scoped.sessionKey(message(command, { from_uid: 'sEVIL_owner', channel_id: 'sEVIL_owner@sEVIL_bot' })))).toBe(true);
 });
 it('refreshes the control identity with the registration channel instead of caching an inferred alias', async () => {
  let ownerChannel = 'sOLD_owner@sOLD_bot';
  const dynamic = new SessionRouter(config, 'bot', 'owner', store, () => ownerChannel);
  quarantine(dynamic.sessionKey(message(command, { from_uid: 'sOLD_owner', channel_id: 'sOLD_owner@sOLD_bot' })));
  ownerChannel = 'sNEW_owner@sNEW_bot';
  await dynamic.routeAndHandle(message(command, { from_uid: 'sOLD_owner', channel_id: 'sOLD_owner@sOLD_bot' }), vi.fn());
  expect(store.isTurnQuarantined(dynamic.sessionKey(message(command, { from_uid: 'sOLD_owner', channel_id: 'sOLD_owner@sOLD_bot' })))).toBe(true);
  quarantine(dynamic.sessionKey(message(command, { from_uid: 'sNEW_owner', channel_id: 'sNEW_owner@sNEW_bot' })));
  await dynamic.routeAndHandle(message(command, { from_uid: 'sNEW_owner', channel_id: 'sNEW_owner@sNEW_bot' }), vi.fn());
  expect(store.isTurnQuarantined(dynamic.sessionKey(message(command, { from_uid: 'sNEW_owner', channel_id: 'sNEW_owner@sNEW_bot' })))).toBe(false);
 });
 it('lets the owner recover a third-party DM from their own DM, without replay', async () => {
  quarantine('alice');
  await router.routeAndHandle(message('help', { from_uid: 'alice', channel_id: 'alice' }), vi.fn());
  expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[0].content).toContain(`--session alice`);
  const model = vi.fn();
  const result = await router.routeAndHandle(message(`/reconcile  ${id}   --session alice  --external-results-verified `), model);
  expect(result?.rejectionReason).toBe('control');
  expect(store.isTurnQuarantined('alice')).toBe(false);
  expect(model).not.toHaveBeenCalled();
  await router.routeAndHandle(message('new task', { from_uid: 'alice', channel_id: 'alice' }), model);
  expect(model).toHaveBeenCalledOnce();
 });
 it('does not allow a non-owner to use an explicit target', async () => {
  quarantine('alice');
  await router.routeAndHandle(message(`/reconcile ${id} --session alice --external-results-verified`, { from_uid: 'mallory', channel_id: 'mallory' }), vi.fn());
  expect(store.isTurnQuarantined('alice')).toBe(true);
  expect(sendMessage).not.toHaveBeenCalled();
 });
 it('requires the exact target and ID and refuses cross-session controls in a group', async () => {
  quarantine('alice');
  await router.routeAndHandle(message(`/reconcile ${id} --session bob --external-results-verified`), vi.fn());
  expect(store.isTurnQuarantined('alice')).toBe(true);
  await router.routeAndHandle(message(command, { channel_id: 'group', channel_type: ChannelType.Group,
    payload: { type: MessageType.Text, content: `/reconcile ${id} --session alice --external-results-verified`, mention: { uids: ['bot'] } } }), vi.fn());
  expect(store.isTurnQuarantined('alice')).toBe(true);
 });
 it('refuses an active target with a useful diagnosis instead of blaming the ID', async () => {
  store.beginTurn('alice', id);
  await router.routeAndHandle(message(`/reconcile ${id} --session alice --external-results-verified`), vi.fn());
  expect(store.getTurnState('alice')).toBe('active');
  expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[0].content).toContain('运行中');
 });
 it('does not let paused senders exhaust the global budget of a healthy owner session', async () => {
  const limited = new SessionRouter({ ...config, rateLimit: { maxPerMinute: 1 } }, 'bot', 'owner', store);
  quarantine('group');
  for (let i = 0; i < 12; i++) {
    await limited.routeAndHandle(message('hi', { from_uid: `user${i}`, channel_id: 'group', channel_type: ChannelType.Group,
      payload: { type: MessageType.Text, content: 'hi', mention: { uids: ['bot'] } } }), vi.fn());
  }
  const model = vi.fn();
  const result = await limited.routeAndHandle(message('healthy'), model);
  expect(result?.shouldProcess).toBe(true);
  expect(model).toHaveBeenCalledOnce();
 });
 it('retains non-clean output evidence beyond retention, then expires it after reconciliation', () => {
  const database = createAdapter(join(root, 'db.sqlite'));
  try {
    quarantine('alice');
    store.saveTurnOutput(id, 'alice', 'generated answer', 1, 'bot');
    store.saveDeliveryPart(id, 0, 'local-key', '{}');
    store.markDeliveryPart(id, 0, 'unknown');
    database.prepare('UPDATE turn_outputs SET created_at=0').run();
    database.prepare('UPDATE turn_execution SET updated_at=0').run();
    store.cleanExpired();
    expect(database.prepare('SELECT state FROM delivery_parts').get()).toMatchObject({ state: 'unknown' });
    expect(database.prepare('SELECT count(*) AS count FROM turn_outputs').get()).toMatchObject({ count: 1 });
    expect(store.isTurnQuarantined('alice')).toBe(true);
    store.reconcileTurn('alice', id);
    store.cleanExpired();
    expect(database.prepare('SELECT count(*) AS count FROM turn_outputs').get()).toMatchObject({ count: 0 });
    expect(database.prepare('SELECT count(*) AS count FROM delivery_parts').get()).toMatchObject({ count: 0 });
  } finally { database.close(); }
 });

 it.each([
  ['owner', '', true],
  ['sPUB_owner', '', false],
  ['sEVIL_owner', 'sPUB_owner@sPUB_bot', false],
  ['sPUB_owner', 'sPUB_owner@sPUB_bot', true],
  ['sPUB_owner', 'sPUB_owner', true],
  ['sPUB_owner', 'sPUB_owner@wrong-bot', false],
  ['sPUB_owner', 'sPUB_owner@sPUB_bot@extra', false],
  ['sPUB_ownerX', 'sPUB_owner@sPUB_bot', false],
 ])('binds control identity %s to registration channel %s', (sender, ownerChannel, allowed) => {
  expect(isOwnerSender(message('', { from_uid: sender, channel_id: sender }), 'owner', ownerChannel, 'bot')).toBe(allowed);
 });
 it('refuses an explicit target while its old handler remains live', async () => {
  const short = new SessionRouter({ ...config, dispatchTimeoutMs: 5 }, 'bot', 'owner', store);
  let finish!: () => void;
  let turn!: TurnContext;
  await short.routeAndHandle(message('task', { from_uid: 'alice', channel_id: 'alice' }), async (_r, t) => {
    turn = t;
    t.executionRisk = 'effects_observed';
    await new Promise<void>(resolve => { finish = resolve; });
  });
  const recover = message(`/reconcile ${turn.turnId} --session alice --external-results-verified`);
  await short.routeAndHandle(recover, vi.fn());
  expect(store.isTurnQuarantined('alice')).toBe(true);
  expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[0].content).toContain('停止处理中');
  finish();
  await new Promise(resolve => setTimeout(resolve, 0));
  await short.routeAndHandle(recover, vi.fn());
  expect(store.isTurnQuarantined('alice')).toBe(false);
 });

});
