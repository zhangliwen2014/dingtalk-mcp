export interface InboxMessage {
    id: number;
    senderId: string;
    content: string;
    timestamp: number;
    read: boolean;
    claimedAt?: number;
}
export interface ProjectChat {
    projectId: string;
    projectTitle: string;
    chatId: string;
    questionIds: number[];
    createdAt: number;
    lastActiveAt: number;
    inbox: InboxMessage[];
    workdir?: string;
}
export declare class ProjectChatManager {
    private chats;
    private nextInboxId;
    private filePath;
    private sentContents;
    constructor(configDir?: string);
    getOrCreateChat(projectId: string, projectTitle: string): Promise<ProjectChat>;
    getProjectByChatId(chatId: string): ProjectChat | undefined;
    getChatByProjectId(projectId: string): ProjectChat | undefined;
    getProjectByWorkdir(workdir: string): ProjectChat | undefined;
    setWorkdir(projectId: string, workdir: string): void;
    recordSentContent(content: string): void;
    wasSentByAgent(content: string): boolean;
    private static normalize;
    listProjectChats(): ProjectChat[];
    addInboxMessage(projectId: string, senderId: string, content: string, timestamp: number): void;
    getUnreadMessages(projectId: string): InboxMessage[];
    claimUnread(projectId: string): InboxMessage[];
    acknowledge(projectId: string, ids: number[]): void;
    releaseLease(projectId: string, ids: number[]): void;
    markAsRead(projectId: string): void;
    getUnreadCount(projectId: string): number;
    save(): void;
    load(): void;
    private findChatByName;
    private createChat;
}
//# sourceMappingURL=project-chat-manager.d.ts.map