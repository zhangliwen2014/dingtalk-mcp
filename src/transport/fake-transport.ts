import { DingTransport, InboundMessage } from './ding-transport.js';

export class FakeTransport implements DingTransport {
  private sentMessages: Array<{ target: string; text: string }> = [];
  private messageHandler?: (message: InboundMessage) => void;

  async sendText(target: string, text: string): Promise<void> {
    this.sentMessages.push({ target, text });
  }

  async listen(handler: (message: InboundMessage) => void): Promise<void> {
    this.messageHandler = handler;
  }

  async resolveTarget(name: string): Promise<string> {
    return `fake-target-${name}`;
  }

  // Test helpers
  getSentMessages(): Array<{ target: string; text: string }> {
    return this.sentMessages;
  }

  simulateInbound(message: InboundMessage): void {
    if (this.messageHandler) {
      this.messageHandler(message);
    }
  }

  clear(): void {
    this.sentMessages = [];
  }
}
