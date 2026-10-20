export interface DingTransport {
  sendText(target: string, text: string): Promise<void>;
  sendToGroupChat(chatId: string, text: string): Promise<void>;
  pollGroupMessages(chatId: string): Promise<PolledGroupMessage[]>;
  resolveTarget(name: string): Promise<string>;
}

export interface PolledGroupMessage {
  messageId: string;
  content: string;
  senderId: string;
  timestamp: number;
  fromAgent: boolean;
}
