import { describe, it, expect } from 'vitest';
import { FakeTransport } from './fake-transport.js';

describe('transport/fake-transport', () => {
  it('records sent messages', async () => {
    const transport = new FakeTransport();
    await transport.sendText('target1', 'hello');
    await transport.sendText('target2', 'world');

    const sent = transport.getSentMessages();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ target: 'target1', text: 'hello' });
    expect(sent[1]).toEqual({ target: 'target2', text: 'world' });
  });

  it('resolves target with fake prefix', async () => {
    const transport = new FakeTransport();
    const resolved = await transport.resolveTarget('alice');
    expect(resolved).toBe('fake-target-alice');
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
      timestamp: Date.now()
    });

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe('answer');
  });

  it('clears sent messages', async () => {
    const transport = new FakeTransport();
    await transport.sendText('target', 'msg');
    expect(transport.getSentMessages()).toHaveLength(1);

    transport.clear();
    expect(transport.getSentMessages()).toHaveLength(0);
  });
});
