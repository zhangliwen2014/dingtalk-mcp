import { describe, it, expect } from 'vitest';
import { FakeTransport } from './fake-transport.js';

describe('transport/fake-transport', () => {
  it('records sent messages', async () => {
    const transport = new FakeTransport();
    await transport.sendText('target1', 'hello');
    await transport.sendText('target2', 'world');

    expect(transport.sentMessages).toHaveLength(2);
    expect(transport.sentMessages[0]).toEqual({ target: 'target1', text: 'hello' });
    expect(transport.sentMessages[1]).toEqual({ target: 'target2', text: 'world' });
  });

  it('resolves target to configured value', async () => {
    const transport = new FakeTransport();
    transport.setResolveTargetResult('user123');
    const resolved = await transport.resolveTarget('alice');
    expect(resolved).toBe('user123');
  });

  it('simulates inbound messages', async () => {
    const transport = new FakeTransport();
    const received: any[] = [];

    await transport.listen((msg) => {
      received.push(msg);
    });

    transport.simulateInbound({
      senderId: 'user1',
      text: 'answer',
      conversationId: 'conv1',
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe('answer');
  });

  it('clears sent messages', async () => {
    const transport = new FakeTransport();
    await transport.sendText('target', 'msg');
    expect(transport.sentMessages).toHaveLength(1);

    transport.clear();
    expect(transport.sentMessages).toHaveLength(0);
  });
});
