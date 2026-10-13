import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGroupMd, getThreadMd } from '../octo/api.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('conversation markdown API contract', () => {
  it.each([false, true])('uses authenticated encoded GET paths (thread=%s)', async (thread) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: 'rules', version: 2 })));
    vi.stubGlobal('fetch', fetchMock);
    const params = { apiUrl: 'https://octo.example/', botToken: 'test-token', groupNo: 'group/one' };
    const result = thread ? await getThreadMd({ ...params, shortId: 'topic/two' }) : await getGroupMd(params);
    expect(result).toEqual({ content: 'rules', version: 2 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://octo.example/v1/bot/groups/group%2Fone' + (thread ? '/threads/topic%2Ftwo/md' : '/md'),
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer test-token' }), signal: expect.any(AbortSignal) }),
    );
  });

  it.each([{}, { content: 3, version: 1 }, { content: 'rules', version: -1 }, { content: 'rules', version: 1.5 }])('rejects malformed responses %j', async (data) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data))));
    await expect(getGroupMd({ apiUrl: 'https://octo.example', botToken: 'token', groupNo: 'group' })).rejects.toThrow('Invalid conversation markdown response');
  });

  it('accepts absent document content and version zero', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: '', version: 0 }))));
    expect(await getGroupMd({ apiUrl: 'https://octo.example', botToken: 'token', groupNo: 'group' })).toEqual({ content: '', version: 0 });
  });

  it.each([403, 404, 500])('propagates HTTP %s for graceful caller degradation', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status })));
    await expect(getThreadMd({ apiUrl: 'https://octo.example', botToken: 'token', groupNo: 'group', shortId: 'topic' })).rejects.toThrow(`(${status})`);
  });
});
