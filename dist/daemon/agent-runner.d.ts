export type AgentPermissionMode = 'full' | 'read-only' | 'accept-edits';
export interface RunnerProject {
    projectId: string;
    projectTitle: string;
    chatId: string;
    workdir: string;
}
export interface AgentRunnerOptions {
    send: (chatId: string, text: string) => Promise<void>;
    ackDelayMs?: number;
    timeoutMs?: number;
    maxLen?: number;
    permissionMode?: AgentPermissionMode;
    configDir?: string;
    command?: string;
}
export declare class AgentRunner {
    private send;
    private ackDelayMs;
    private timeoutMs;
    private maxLen;
    private permissionMode;
    private command;
    private queue;
    private running;
    private current;
    constructor(options: AgentRunnerOptions);
    getPermissionMode(): AgentPermissionMode;
    enqueue(project: RunnerProject, content: string): void;
    stop(): void;
    private drain;
    private runOne;
    private interpret;
    private lastResult;
    private deliver;
}
//# sourceMappingURL=agent-runner.d.ts.map