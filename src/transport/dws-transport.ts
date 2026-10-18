import { DingTransport, InboundMessage } from './ding-transport.js';
import * as proc from '../platform/proc.js';

export class DwsTransport implements DingTransport {
  private messageHandler?: (message: InboundMessage) => void;

  async sendText(target: string, text: string): Promise<void> {
    const result = await proc.run([
      'dws',
      'chat',
      '+dm',
      '--to',
      target,
      '--content',
      text,
      '--format',
      'json'
    ]);

    if (result.code !== 0) {
      throw new Error(`dws sendText failed: ${result.stderr}`);
    }
  }

  async listen(handler: (message: InboundMessage) => void): Promise<void> {
    this.messageHandler = handler;
  }

  handleInbound(message: InboundMessage): void {
    if (this.messageHandler) {
      this.messageHandler(message);
    }
  }

  async resolveTarget(name: string): Promise<string> {
    const result = await proc.run([
      'dws',
      'contact',
      'user',
      'search',
      '--query',
      name,
      '--format',
      'json'
    ]);

    if (result.code !== 0) {
      throw new Error(`dws resolveTarget failed: ${result.stderr}`);
    }

    // TODO: Parse JSON output and extract userId
    // For now, return the name as-is (will be refined after V1 verification)
    return name;
  }
}
