import { describe, it, expect, vi } from 'vitest';
import { ChatPoller } from './chat-poller.js';
import type { PolledGroupMessage } from '../transport/ding-transport.js';

function msg(
  id: string,
  content: string,
  opts: Partial<PolledGroupMessage> = {}
): PolledGroupMessage {
  return {
    messageId: id,
    content,
    senderId: 'user-1',
    timestamp: 1000,
    fromAgent: false,
    ...opts,
  };
}

function makeTransport(lists: PolledGroupMessage[][]) {
  let call = 0;
  return {
    pollGroupMessages: vi.fn(async () => {
      const idx = Math.min(call, lists.length - 1);
      call++;
      return lists[idx];
    }),
  };
}

describe('daemon/chat-poller', () => {
  it('baselines on first poll without processing existing messages', async () => {
    const onMessage = vi.fn();
    const transport = makeTransport([[msg('a', 'old1'), msg('b', 'old2')]]);
    const poller = new ChatPoller({ transport, onMessage });

    const processed = await poller.pollOnce('chat-1');

    expect(processed).toBe(0);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('processes new messages that appear after baseline', async () => {
    const onMessage = vi.fn();
    const transport = makeTransport([
      [msg('a', 'old')],
      [msg('a', 'old'), msg('b', 'fresh')],
    ]);
    const poller = new ChatPoller({ transport, onMessage });

    await poller.pollOnce('chat-1'); // baseline
    const processed = await poller.pollOnce('chat-1');

    expect(processed).toBe(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      content: 'fresh',
      senderId: 'user-1',
    });
  });

  it('never re-processes a message id already seen', async () => {
    const onMessage = vi.fn();
    const transport = makeTransport([
      [],
      [msg('x', 'dup')],
      [msg('x', 'dup')],
    ]);
    const poller = new ChatPoller({ transport, onMessage });

    await poller.pollOnce('chat-1'); // baseline (empty)
    await poller.pollOnce('chat-1'); // sees x, processes
    const second = await poller.pollOnce('chat-1'); // x already seen

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(second).toBe(0);
  });

  it('skips agent-sent messages but records them as seen', async () => {
    const onMessage = vi.fn();
    const transport = makeTransport([
      [],
      [msg('s1', 'agent ack', { fromAgent: true }), msg('u1', 'human')],
    ]);
    const poller = new ChatPoller({ transport, onMessage });

    await poller.pollOnce('chat-1'); // baseline empty
    const processed = await poller.pollOnce('chat-1');

    expect(processed).toBe(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].content).toBe('human');
  });

  it('survives transport errors without throwing or processing', async () => {
    const onMessage = vi.fn();
    const transport = {
      pollGroupMessages: vi.fn(async () => {
        throw new Error('dws unavailable');
      }),
    };
    const poller = new ChatPoller({ transport, onMessage });

    const processed = await poller.pollOnce('chat-1');

    expect(processed).toBe(0);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('tracks state per chat independently', async () => {
    const onMessage = vi.fn();
    const transport = {
      pollGroupMessages: vi.fn(async (chatId: string) =>
        chatId === 'chat-A' ? [msg('a1', 'from A')] : [msg('b1', 'from B')]
      ),
    };
    const poller = new ChatPoller({ transport, onMessage });

    await poller.pollOnce('chat-A'); // baseline A
    await poller.pollOnce('chat-B'); // baseline B
    // second round: same ids now seen → nothing new
    const pA = await poller.pollOnce('chat-A');
    const pB = await poller.pollOnce('chat-B');

    expect(pA).toBe(0);
    expect(pB).toBe(0);
    expect(onMessage).not.toHaveBeenCalled();
  });
});
