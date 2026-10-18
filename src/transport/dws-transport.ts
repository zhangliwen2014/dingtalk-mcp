import { DingTransport, InboundMessage } from './ding-transport.js';
import * as proc from '../platform/proc.js';

export class DwsTransport implements DingTransport {
  private messageHandler?: (message: InboundMessage) => void;
  private polling = false;
  private lastPollTime?: Date;
  private pollInterval?: NodeJS.Timeout;

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
      'json',
      '--yes'
    ]);

    if (result.code !== 0) {
      throw new Error(`dws sendText failed: ${result.stderr}`);
    }
  }

  async listen(handler: (message: InboundMessage) => void): Promise<void> {
    this.messageHandler = handler;
    this.lastPollTime = new Date();
    this.polling = true;

    // Poll every 3 seconds
    this.pollInterval = setInterval(() => {
      this.pollMessages().catch((err) => {
        console.error('Poll error:', err);
      });
    }, 3000);
  }

  stopListening(): void {
    this.polling = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
  }

  private async pollMessages(): Promise<void> {
    if (!this.polling || !this.messageHandler || !this.lastPollTime) {
      return;
    }

    const timeStr = this.lastPollTime.toISOString().replace('T', ' ').substring(0, 19);
    console.log(`[Poll] Checking messages after ${timeStr}`);

    const result = await proc.run([
      'dws',
      'chat',
      '+chat-messages',
      '--user',
      '016825045624390379',
      '--time',
      timeStr,
      '--direction',
      'newer',
      '--limit',
      '50',
      '--format',
      'json'
    ]);

    if (result.code !== 0) {
      console.error('[Poll] Error:', result.stderr);
      throw new Error(`dws pollMessages failed: ${result.stderr}`);
    }

    try {
      const data = JSON.parse(result.stdout);
      const messages = data.messages || [];
      console.log(`[Poll] Found ${messages.length} messages`);

      for (const msg of messages) {
        // Skip messages sent by DWS (our own messages)
        if (msg.messageAiSendFlag === 'DWS') {
          console.log(`[Poll] Skipping self-sent message: ${msg.text}`);
          continue;
        }
        
        if (msg.text && msg.senderId) {
          const timestamp = new Date(msg.createTime).getTime();
          if (timestamp > this.lastPollTime.getTime()) {
            console.log(`[Poll] Received: ${msg.text}`);
            this.messageHandler({
              senderId: msg.senderId,
              text: msg.text,
              conversationId: msg.conversationId || '',
              timestamp,
            });
            this.lastPollTime = new Date(timestamp);
          }
        }
      }
    } catch (err) {
      console.error('[Poll] Failed to parse result:', err);
    }
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
