import { DingTransport, PolledGroupMessage } from './ding-transport.js';
export declare class FakeTransport implements DingTransport {
    sentMessages: Array<{
        target: string;
        text: string;
    }>;
    sentGroupMessages: Array<{
        chatId: string;
        text: string;
    }>;
    groupMessages: PolledGroupMessage[];
    private resolveTargetResult;
    sendText(target: string, text: string): Promise<void>;
    sendToGroupChat(chatId: string, text: string): Promise<void>;
    pollGroupMessages(_chatId: string): Promise<PolledGroupMessage[]>;
    setGroupMessages(messages: PolledGroupMessage[]): void;
    resolveTarget(name: string): Promise<string>;
    setResolveTargetResult(target: string): void;
    clear(): void;
}
//# sourceMappingURL=fake-transport.d.ts.map