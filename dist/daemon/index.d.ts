export declare function resolveHeadlessEnabled(configDir: string): boolean;
export declare function resolveAllowedSenderIds(configDir: string): string[] | undefined;
export declare class Daemon {
    private server;
    private instance;
    private transport;
    private projectChatManager;
    private poller;
    private agentRunner;
    private sessionRegistry;
    start(): Promise<void>;
    stop(): Promise<void>;
    private listenForChat;
}
//# sourceMappingURL=index.d.ts.map