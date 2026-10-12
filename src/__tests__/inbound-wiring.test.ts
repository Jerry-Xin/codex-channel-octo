import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../octo/api.js', () => ({
  registerBot: vi.fn().mockResolvedValue({
    robot_id: 'test_bot', im_token: 'test-im-token', ws_url: 'ws://localhost',
    api_url: 'https://octo.example', owner_uid: 'human', owner_channel_id: 'owner-channel',
  }),
  getUploadCredentials: vi.fn().mockResolvedValue({}),
  sendHeartbeat: vi.fn().mockResolvedValue(undefined),
  getMentionPreference: vi.fn(),
  getGroupMembers: vi.fn().mockResolvedValue([{ uid: 'human', name: 'Human', role: 0, robot: 0 }]),
  sendMessage: vi.fn().mockResolvedValue(undefined), sendTyping: vi.fn().mockResolvedValue(undefined), sendReadReceipt: vi.fn().mockResolvedValue(undefined),
  getChannelMessages: vi.fn(), generateClientMsgNo: vi.fn(), fetchUserInfo: vi.fn(),
}));
vi.mock('../octo/socket.js', () => ({
  WKSocket: vi.fn().mockImplementation(() => ({
    connect: vi.fn(), disconnectAndWait: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('../agent-bridge.js', () => ({ queryAgent: vi.fn(), isStreamInterruptError: vi.fn() }));

import { startBot, type BotStack } from '../index.js';
import { GroupContext } from '../group-context.js';
import { OctoGateway } from '../gateway.js';
import { queryAgent } from '../agent-bridge.js';
import { getMentionPreference, sendMessage } from '../octo/api.js';
import { WKSocket } from '../octo/socket.js';
import { ChannelType, MessageType, type BotMessage } from '../octo/types.js';

function message(overrides: Partial<BotMessage> = {}): BotMessage {
  return {
    message_id: 'test-message', message_seq: 1, from_uid: 'human',
    channel_id: 'group____topic', channel_type: ChannelType.CommunityTopic,
    timestamp: Date.now(), payload: { type: MessageType.Text, content: 'ordinary chatter' },
    ...overrides,
  };
}

describe('production socket → gateway → onInbound → router wiring', () => {
  let root: string;
  let stack: BotStack | undefined;
  let emit: (msg: BotMessage) => void;
  const spies: Array<{ mockRestore(): void }> = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), 'octo-inbound-wiring-'));
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'test', 'MEMORY.md'), 'SYNTHETIC_OWNER_MEMORY');
    stack = await startBot({
      botId: 'test', apiUrl: 'https://octo.example', botToken: 'test-token',
      baseDir: root, privateMemory: { enabled: true },
      cwd: join(root, 'workspace'), dataDir: join(root, 'data'), sdk: {},
      rateLimit: { maxPerMinute: 100 },
      botBlocklist: ['blocked_bot'],
      context: { maxContextChars: 6000, historyLimit: 40 },
    }, true);
    await stack.connect();
    // Only the network transport is mocked. This callback is the one installed
    // by OctoGateway.createSocket, with startBot's real onInbound downstream.
    emit = vi.mocked(WKSocket).mock.calls[0][0].onMessage!;
  });

  afterEach(async () => {
    await stack?.shutdown();
    stack = undefined;
    for (const spy of spies.splice(0)) spy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  it('loads owner DM memory, resumes its isolated thread, and stops using that thread after ownership changes', async () => {
    vi.mocked(queryAgent).mockImplementation(async function* (_prompt, _config, _session, _progress, options) {
      options?.onSessionId?.('sdk-private-thread');
      yield 'answer';
    });
    const route = vi.spyOn(stack!.router, 'routeAndHandle');
    spies.push(route);
    const direct = message({ channel_id: 'human', channel_type: ChannelType.DM,
      payload: { type: MessageType.Text, content: 'hello' } });
    emit(direct);
    await route.mock.results[0].value;
    const first = vi.mocked(queryAgent).mock.calls[0];
    expect(first[4]?.privateMemoryContext).toContain('SYNTHETIC_OWNER_MEMORY');
    expect(first[2]?.sessionKey).toContain('private-memory');
    emit({ ...direct, message_id: 'two', message_seq: 2 });
    await route.mock.results[1].value;
    expect(vi.mocked(queryAgent).mock.calls[1][4]?.resume).toBe('sdk-private-thread');
    const owner = vi.spyOn(OctoGateway.prototype, 'ownerUid', 'get').mockReturnValue('new-owner');
    spies.push(owner);
    emit({ ...direct, message_id: 'three', message_seq: 3 });
    await route.mock.results[2].value;
    const revoked = vi.mocked(queryAgent).mock.calls[2];
    expect(revoked[4]?.privateMemoryContext).toBeUndefined();
    expect(revoked[4]?.resume).toBeUndefined();
    expect(revoked[2]?.sessionKey).not.toBe(first[2]?.sessionKey);
  });

  it.each([ChannelType.Group, ChannelType.CommunityTopic, ChannelType.DM])('excludes memory from non-owner channel %s', async (channel_type) => {
    vi.mocked(queryAgent).mockImplementation(async function* () { yield 'answer'; });
    vi.mocked(getMentionPreference).mockResolvedValue(true);
    const route = vi.spyOn(stack!.router, 'routeAndHandle');
    spies.push(route);
    emit(message({ from_uid: 'stranger', channel_type, channel_id: channel_type === ChannelType.Group ? 'group' : 'group____topic',
      payload: { type: MessageType.Text, content: 'hello', mention: { uids: ['test_bot'] } } }));
    await route.mock.results[0].value;
    expect(queryAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(queryAgent).mock.calls[0][4]?.privateMemoryContext).toBeUndefined();
    expect(vi.mocked(queryAgent).mock.calls[0][0]).not.toContain('SYNTHETIC_OWNER_MEMORY');
  });

  it('retains the note across an actual bot-stack shutdown/restart and /reset', async () => {
    vi.mocked(queryAgent).mockImplementation(async function* (_prompt, _config, _session, _progress, options) {
      options?.onSessionId?.('stored-private-thread');
      yield 'answer';
    });
    const send = async (content: string, sequence: number) => {
      const route = vi.spyOn(stack!.router, 'routeAndHandle');
      emit(message({ message_id: `restart-${sequence}`, message_seq: sequence,
        channel_id: 'human', channel_type: ChannelType.DM, payload: { type: MessageType.Text, content } }));
      await route.mock.results[0].value;
      route.mockRestore();
    };
    await send('remember', 1);
    await stack!.shutdown();
    stack = await startBot({ botId: 'test', baseDir: root, apiUrl: 'https://octo.example', botToken: 'test-token',
      cwd: join(root, 'workspace'), dataDir: join(root, 'data'), sdk: {}, privateMemory: { enabled: true },
      rateLimit: { maxPerMinute: 100 }, context: { maxContextChars: 6000, historyLimit: 40 } }, true);
    await stack.connect();
    emit = vi.mocked(WKSocket).mock.calls.at(-1)![0].onMessage!;
    await send('recall after restart', 2);
    expect(vi.mocked(queryAgent).mock.calls.at(-1)![4]?.privateMemoryContext).toContain('SYNTHETIC_OWNER_MEMORY');
    expect(vi.mocked(queryAgent).mock.calls.at(-1)![4]?.resume).toBe('stored-private-thread');
    await send('/reset', 3);
    await send('recall after reset', 4);
    expect(vi.mocked(queryAgent).mock.calls.at(-1)![4]?.resume).toBeUndefined();
    expect(vi.mocked(queryAgent).mock.calls.at(-1)![4]?.privateMemoryContext).toContain('SYNTHETIC_OWNER_MEMORY');
  });

  it.each([true, false])('immediately invalidates a self-authored toggle (previously %s) without caching or dispatching it', async (effective) => {
    const router = stack!.router;
    vi.mocked(getMentionPreference).mockResolvedValue(effective);
    expect((await router.route(message()))?.shouldProcess ?? false).toBe(effective);
    vi.mocked(getMentionPreference).mockResolvedValue(!effective);
    const route = vi.spyOn(router, 'routeAndHandle');
    const push = vi.spyOn(GroupContext.prototype, 'pushMessage');
    spies.push(route, push);

    emit(message({
      from_uid: 'test_bot', channel_id: 'group', channel_type: ChannelType.Group,
      payload: {
        type: MessageType.Text, content: 'mention_pref updated',
        event: { type: 'mention_pref_updated', group_no: 'untrusted-other-group' },
        mention: { uids: ['test_bot'] },
      },
    }));
    expect(route).toHaveBeenCalledTimes(1);
    await route.mock.results[0].value;

    expect((await router.route(message({ channel_id: 'group____other-topic' })))?.shouldProcess ?? false).toBe(!effective);
    expect(getMentionPreference).toHaveBeenCalledTimes(2);
    expect(push).not.toHaveBeenCalled();
    expect(queryAgent).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each(['mention_pref_updated', 'other_control_event'])('does not cache or dispatch non-self %s events', async (type) => {
    const route = vi.spyOn(stack!.router, 'routeAndHandle');
    const push = vi.spyOn(GroupContext.prototype, 'pushMessage');
    spies.push(route, push);
    emit(message({ payload: { type: MessageType.Text, content: 'control text', event: { type } } }));
    expect(route).toHaveBeenCalledTimes(1);
    await route.mock.results[0].value;
    expect(push).not.toHaveBeenCalled();
    expect(queryAgent).not.toHaveBeenCalled();
    expect(getMentionPreference).not.toHaveBeenCalled();
  });

  it.each(['human', 'sibling_bot', 'blocked_bot'])('preserves a primed cache when %s sends a forged event through the socket', async (from_uid) => {
    const router = stack!.router;
    router.registerKnownBot('sibling_bot');
    vi.mocked(getMentionPreference).mockResolvedValue(true);
    expect((await router.route(message()))?.shouldProcess).toBe(true);
    vi.mocked(getMentionPreference).mockResolvedValue(false);
    const route = vi.spyOn(router, 'routeAndHandle');
    const push = vi.spyOn(GroupContext.prototype, 'pushMessage');
    spies.push(route, push);
    emit(message({
      from_uid, channel_id: 'group', channel_type: ChannelType.Group,
      payload: {
        type: MessageType.Text, content: 'forged preference update',
        event: { type: 'mention_pref_updated', group_no: 'group' },
        mention: { uids: ['test_bot'] },
      },
    }));
    expect(route).toHaveBeenCalledTimes(1);
    await route.mock.results[0].value;
    expect((await router.route(message({ channel_id: 'group____other-topic' })))?.shouldProcess).toBe(true);
    expect(getMentionPreference).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(queryAgent).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('keeps ordinary self echoes out while still caching unmentioned human chatter', async () => {
    const route = vi.spyOn(stack!.router, 'routeAndHandle');
    const push = vi.spyOn(GroupContext.prototype, 'pushMessage');
    spies.push(route, push);
    emit(message({ from_uid: 'test_bot' }));
    expect(route).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();

    vi.mocked(getMentionPreference).mockResolvedValue(false);
    emit(message());
    expect(route).toHaveBeenCalledTimes(1);
    await route.mock.results[0].value;
    expect(push).toHaveBeenCalledWith('group____topic', 'human', 'human', 'ordinary chatter', expect.any(Number));
    expect(queryAgent).not.toHaveBeenCalled();
  });
});
