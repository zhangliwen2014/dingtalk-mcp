import type { PolledGroupMessage } from '../transport/ding-transport.js';

export interface PollerMessage {
  chatId: string;
  content: string;
  senderId: string;
}

export interface PollTransport {
  pollGroupMessages(chatId: string): Promise<PolledGroupMessage[]>;
}

export interface ChatPollerOptions {
  transport: PollTransport;
  onMessage: (message: PollerMessage) => void | Promise<void>;
  intervalMs?: number;
}

interface ChatState {
  seen: Set<string>;
  initialized: boolean;
  timer?: NodeJS.Timeout;
}

const DEFAULT_INTERVAL_MS = 3000;
const MAX_SEEN = 500;

export class ChatPoller {
  private transport: PollTransport;
  private onMessage: (message: PollerMessage) => void | Promise<void>;
  private intervalMs: number;
  private states: Map<string, ChatState> = new Map();

  constructor(options: ChatPollerOptions) {
    this.transport = options.transport;
    this.onMessage = options.onMessage;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  start(chatId: string): void {
    let state = this.states.get(chatId);
    if (!state) {
      state = { seen: new Set<string>(), initialized: false };
      this.states.set(chatId, state);
    }
    if (state.timer) {
      return;
    }

    state.timer = setInterval(() => {
      this.pollOnce(chatId).catch((err) => {
        console.error(`Poller tick failed for ${chatId}:`, err);
      });
    }, this.intervalMs);

    this.pollOnce(chatId).catch((err) => {
      console.error(`Initial poll failed for ${chatId}:`, err);
    });
  }

  stop(chatId: string): void {
    const state = this.states.get(chatId);
    if (state?.timer) {
      clearInterval(state.timer);
      state.timer = undefined;
    }
  }

  stopAll(): void {
    for (const chatId of this.states.keys()) {
      this.stop(chatId);
    }
    this.states.clear();
  }

  async pollOnce(chatId: string): Promise<number> {
    let state = this.states.get(chatId);
    if (!state) {
      state = { seen: new Set<string>(), initialized: false };
      this.states.set(chatId, state);
    }

    let messages: PolledGroupMessage[];
    try {
      messages = await this.transport.pollGroupMessages(chatId);
    } catch (err) {
      console.error(`pollGroupMessages failed for ${chatId}:`, err);
      return 0;
    }

    if (!state.initialized) {
      for (const m of messages) {
        this.remember(state, m.messageId);
      }
      state.initialized = true;
      return 0;
    }

    let processed = 0;
    for (const m of messages) {
      if (state.seen.has(m.messageId)) {
        continue;
      }
      this.remember(state, m.messageId);
      if (m.fromAgent || !m.content) {
        continue;
      }
      await this.onMessage({
        chatId,
        content: m.content,
        senderId: m.senderId,
      });
      processed++;
    }
    return processed;
  }

  private remember(state: ChatState, messageId: string): void {
    state.seen.add(messageId);
    if (state.seen.size > MAX_SEEN) {
      const oldest = state.seen.values().next().value;
      if (oldest !== undefined) {
        state.seen.delete(oldest);
      }
    }
  }
}
