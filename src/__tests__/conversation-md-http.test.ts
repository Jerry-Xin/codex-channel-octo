import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConversationMarkdown } from '../conversation-md.js';
import { ChannelType, MessageType, type BotMessage } from '../octo/types.js';

let server: Server;
let apiUrl: string;
let status: number;
let groupContent: string;
let threadContent: string;
let paths: string[];
let authorizations: Array<string | undefined>;

beforeEach(async () => {
  status = 200;
  groupContent = 'initial server group';
  threadContent = 'initial server thread';
  paths = [];
  authorizations = [];
  server = createServer((request, response) => {
    paths.push(request.url!);
    authorizations.push(request.headers.authorization);
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ content: request.url?.includes('/threads/') ? threadContent : groupContent, version: 1 }));
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
});

function event(type: string, channel_id: string, channel_type: ChannelType): BotMessage {
  return {
    message_id: 'event', message_seq: 1, from_uid: 'bot', channel_id, channel_type,
    timestamp: 1, payload: { type: MessageType.Text, event: { type } },
  };
}

describe('real localhost HTTP → markdown cache', () => {
  it('reads group and topic documents, then refreshes or deletes them without restarting', async () => {
    const cache = new ConversationMarkdown({ apiUrl, botToken: 'fixture-token' });
    expect(await cache.get('group', ChannelType.Group)).toContain('initial server group');
    expect(await cache.get('group____topic', ChannelType.CommunityTopic)).toContain('initial server thread');
    groupContent = 'updated server group';
    threadContent = 'updated server thread';
    cache.onEvent(event('group_md_updated', 'group', ChannelType.Group), 'bot');
    cache.onEvent(event('thread_md_updated', 'group____topic', ChannelType.CommunityTopic), 'bot');
    expect(await cache.get('group', ChannelType.Group)).toContain('updated server group');
    expect(await cache.get('group____topic', ChannelType.CommunityTopic)).toContain('updated server thread');
    cache.onEvent(event('thread_md_deleted', 'group____topic', ChannelType.CommunityTopic), 'bot');
    expect(await cache.get('group____topic', ChannelType.CommunityTopic)).toBeUndefined();
    expect(paths).toEqual([
      '/v1/bot/groups/group/md', '/v1/bot/groups/group/threads/topic/md',
      '/v1/bot/groups/group/md', '/v1/bot/groups/group/threads/topic/md',
    ]);
    expect(authorizations).toEqual(Array(4).fill('Bearer fixture-token'));
  });

  it.each([403, 404, 500])('omits unavailable HTTP %s documents instead of crashing the conversation', async (httpStatus) => {
    status = httpStatus;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cache = new ConversationMarkdown({ apiUrl, botToken: 'fixture-token' });
    expect(await cache.get('group', ChannelType.Group)).toBeUndefined();
    expect(warning).toHaveBeenCalledOnce();
    expect(paths).toEqual(['/v1/bot/groups/group/md']);
  });
});
