import { DingTransport, InboundMessage } from './ding-transport.js';

export class FakeTransport implements DingTransport {
  sentMessages: Array<{ target: string; text: string }> = [];
  private messageHandler?: (message: InboundMessage) => void;
  private resolveTargetResult = 'fake-target';

  async sendText(target: string, text: string): Promise<void> {
    this.sentMessages.push({ target, text });
  }

  async listen(handler: (message: InboundMessage) => void): Promise<void> {
    this.messageHandler = handler;
  }

  async resolveTarget(name: string): Promise<string> {
    return this.resolveTargetResult;
  }

  setResolveTargetResult(target: string): void {
    this.resolveTargetResult = target;
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
