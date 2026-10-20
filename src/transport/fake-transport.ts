import {
  DingTransport,
  PolledGroupMessage,
} from './ding-transport.js';

export class FakeTransport implements DingTransport {
  sentMessages: Array<{ target: string; text: string }> = [];
  sentGroupMessages: Array<{ chatId: string; text: string }> = [];
  groupMessages: PolledGroupMessage[] = [];
  private resolveTargetResult = 'fake-target';

  async sendText(target: string, text: string): Promise<void> {
    this.sentMessages.push({ target, text });
  }

  async sendToGroupChat(chatId: string, text: string): Promise<void> {
    this.sentGroupMessages.push({ chatId, text });
  }

  async pollGroupMessages(_chatId: string): Promise<PolledGroupMessage[]> {
    return [...this.groupMessages];
  }

  setGroupMessages(messages: PolledGroupMessage[]): void {
    this.groupMessages = messages;
  }

  async resolveTarget(name: string): Promise<string> {
    return this.resolveTargetResult;
  }

  setResolveTargetResult(target: string): void {
    this.resolveTargetResult = target;
  }

  clear(): void {
    this.sentMessages = [];
    this.sentGroupMessages = [];
  }
}
