export interface DingTransport {
  sendText(target: string, text: string): Promise<void>;
  listen(handler: (message: InboundMessage) => void): Promise<void>;
  resolveTarget(name: string): Promise<string>;
}

export interface InboundMessage {
  senderId: string;
  text: string;
  conversationId: string;
  timestamp: number;
}
