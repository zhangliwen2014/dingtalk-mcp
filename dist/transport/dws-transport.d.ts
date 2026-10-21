import { DingTransport, PolledGroupMessage } from './ding-transport.js';
export declare class DwsTransport implements DingTransport {
    sendText(target: string, text: string): Promise<void>;
    sendToGroupChat(chatId: string, text: string): Promise<void>;
    pollGroupMessages(chatId: string): Promise<PolledGroupMessage[]>;
    resolveTarget(name: string): Promise<string>;
}
//# sourceMappingURL=dws-transport.d.ts.map