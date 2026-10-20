import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DwsTransport } from './dws-transport.js';
import * as proc from '../platform/proc.js';

vi.mock('../platform/proc.js');

describe('transport/dws-transport pollGroupMessages', () => {
  let transport: DwsTransport;

  beforeEach(() => {
    transport = new DwsTransport();
    vi.clearAllMocks();
  });

  it('maps group messages and flags agent-sent ones', async () => {
    vi.mocked(proc.run).mockResolvedValueOnce({
      code: 0,
      stderr: '',
      stdout: JSON.stringify({
        messages: [
          {
            messageId: 'm1',
            text: 'hello',
            senderId: 'user-9',
            createTime: '2026-10-19 06:40:19',
          },
          {
            messageId: 'm2',
            text: 'ack',
            senderId: 'user-9',
            createTime: '2026-10-19 06:40:25',
            messageAiSendFlag: 'DWS',
          },
        ],
      }),
    });

    const result = await transport.pollGroupMessages('cid-abc');

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      messageId: 'm1',
      content: 'hello',
      senderId: 'user-9',
      fromAgent: false,
    });
    expect(result[1].fromAgent).toBe(true);
  });

  it('queries the group via --group flag', async () => {
    vi.mocked(proc.run).mockResolvedValueOnce({
      code: 0,
      stderr: '',
      stdout: JSON.stringify({ messages: [] }),
    });

    await transport.pollGroupMessages('cid-xyz');

    const args = vi.mocked(proc.run).mock.calls[0][0];
    expect(args).toContain('--group');
    expect(args).toContain('cid-xyz');
  });

  it('throws when dws command fails', async () => {
    vi.mocked(proc.run).mockResolvedValueOnce({
      code: 1,
      stderr: 'boom',
      stdout: '',
    });

    await expect(transport.pollGroupMessages('cid-1')).rejects.toThrow();
  });

  it('returns empty array when no messages field', async () => {
    vi.mocked(proc.run).mockResolvedValueOnce({
      code: 0,
      stderr: '',
      stdout: JSON.stringify({}),
    });

    const result = await transport.pollGroupMessages('cid-1');
    expect(result).toEqual([]);
  });
});
