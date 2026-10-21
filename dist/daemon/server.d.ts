import { Switch } from '../core/switch.js';
import { Registry } from '../core/registry.js';
import { DingTransport } from '../transport/ding-transport.js';
import { ProjectChatManager } from '../core/project-chat-manager.js';
import type { AgentRunner } from './agent-runner.js';
import type { SessionRegistry } from './session-registry.js';
export interface DaemonServerOptions {
    transport: DingTransport;
    switch: Switch;
    registry: Registry;
    ipcEndpoint: string;
    projectChatManager?: ProjectChatManager;
    onChatCreated?: (chatId: string) => void;
    agentRunner?: Pick<AgentRunner, 'enqueue'>;
    sessionRegistry?: Pick<SessionRegistry, 'isActive' | 'ping' | 'leave'>;
    headlessEnabled?: boolean;
    allowedSenderIds?: string[];
}
export declare class DaemonServer {
    private server;
    private sockets;
    private transport;
    private switch;
    readonly registry: Registry;
    private ipcEndpoint;
    private projectChatManager?;
    private onChatCreated?;
    private agentRunner?;
    private sessionRegistry?;
    private headlessEnabled;
    private allowedSenderIds?;
    constructor(options: DaemonServerOptions);
    start(): Promise<void>;
    stop(): Promise<void>;
    rpc(method: string, params: any): Promise<any>;
    private handleHello;
    private handleAsk;
    private handleProjectAsk;
    private handleLegacyAsk;
    private handleCheck;
    private handleCancel;
    private handleStatus;
    private handleSetSwitch;
    private handleIngest;
    handleChatMessage(params: {
        chatId: string;
        content: string;
        senderId?: string;
    }): Promise<any>;
    private sendAck;
    private sendNotice;
    private handleHookPing;
    private handleHookLeave;
    private handleHookPoll;
    private handleHookRegister;
    private handleHookAck;
    private handleHookUnclaim;
    private handleHookMirror;
    private handleReplyToProject;
    private handleReadProjectMessages;
    private handleListProjectInboxes;
    private handleListProjects;
    private handleConnection;
    private handleRequest;
}
//# sourceMappingURL=server.d.ts.map