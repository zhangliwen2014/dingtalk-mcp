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
export declare class ChatPoller {
    private transport;
    private onMessage;
    private intervalMs;
    private states;
    constructor(options: ChatPollerOptions);
    start(chatId: string): void;
    stop(chatId: string): void;
    stopAll(): void;
    pollOnce(chatId: string): Promise<number>;
    private remember;
}
//# sourceMappingURL=chat-poller.d.ts.map