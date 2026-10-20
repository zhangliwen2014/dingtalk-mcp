import * as proc from '../platform/proc.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as paths from '../platform/paths.js';

const STATE_FILE = 'project-chats.json';
const MAX_INBOX_SIZE = 100;

export interface InboxMessage {
  id: number;
  senderId: string;
  content: string;
  timestamp: number;
  read: boolean;
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

interface PersistedState {
  nextInboxId: number;
  chats: ProjectChat[];
}

export class ProjectChatManager {
  private chats: Map<string, ProjectChat> = new Map();
  private nextInboxId = 1;
  private filePath: string;
  private sentContents: Set<string> = new Set();

  constructor(configDir?: string) {
    const dir = configDir || paths.home();
    this.filePath = path.join(dir, STATE_FILE);
  }

  async getOrCreateChat(projectId: string, projectTitle: string): Promise<ProjectChat> {
    const existing = this.chats.get(projectId);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return existing;
    }

    const chatName = `${projectTitle}问答`;
    let chatId = await this.findChatByName(chatName);

    if (!chatId) {
      chatId = await this.createChat(chatName);
    }

    const chat: ProjectChat = {
      projectId,
      projectTitle,
      chatId,
      questionIds: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      inbox: [],
    };

    this.chats.set(projectId, chat);
    this.save();
    return chat;
  }

  getProjectByChatId(chatId: string): ProjectChat | undefined {
    return Array.from(this.chats.values()).find((c) => c.chatId === chatId);
  }

  getChatByProjectId(projectId: string): ProjectChat | undefined {
    return this.chats.get(projectId);
  }

  getProjectByWorkdir(workdir: string): ProjectChat | undefined {
    const target = paths.resolveDir(workdir);
    return Array.from(this.chats.values()).find(
      (c) => c.workdir && paths.resolveDir(c.workdir) === target
    );
  }

  setWorkdir(projectId: string, workdir: string): void {
    const chat = this.chats.get(projectId);
    if (!chat) return;
    chat.workdir = workdir;
    this.save();
  }

  recordSentContent(content: string): void {
    this.sentContents.add(content);
    if (this.sentContents.size > 200) {
      const keep = Array.from(this.sentContents).slice(-100);
      this.sentContents = new Set(keep);
    }
  }

  wasSentByAgent(content: string): boolean {
    return this.sentContents.has(content);
  }

  listProjectChats(): ProjectChat[] {
    return Array.from(this.chats.values());
  }

  addInboxMessage(projectId: string, senderId: string, content: string, timestamp: number): void {
    const chat = this.chats.get(projectId);
    if (!chat) return;

    const message: InboxMessage = {
      id: this.nextInboxId++,
      senderId,
      content,
      timestamp,
      read: false,
    };

    chat.inbox.push(message);

    if (chat.inbox.length > MAX_INBOX_SIZE) {
      chat.inbox.splice(0, chat.inbox.length - MAX_INBOX_SIZE);
    }

    chat.lastActiveAt = Date.now();
    this.save();
  }

  getUnreadMessages(projectId: string): InboxMessage[] {
    const chat = this.chats.get(projectId);
    if (!chat) return [];
    return chat.inbox.filter((m) => !m.read);
  }

  claimUnread(projectId: string): InboxMessage[] {
    const chat = this.chats.get(projectId);
    if (!chat) return [];
    const unread = chat.inbox.filter((m) => !m.read);
    if (unread.length === 0) {
      return unread;
    }
    for (const msg of unread) {
      msg.read = true;
    }
    this.save();
    return unread;
  }

  markAsRead(projectId: string): void {
    const chat = this.chats.get(projectId);
    if (!chat) return;
    for (const msg of chat.inbox) {
      msg.read = true;
    }
    this.save();
  }

  getUnreadCount(projectId: string): number {
    const chat = this.chats.get(projectId);
    if (!chat) return 0;
    return chat.inbox.filter((m) => !m.read).length;
  }

  save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const state: PersistedState = {
      nextInboxId: this.nextInboxId,
      chats: Array.from(this.chats.values()),
    };

    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), {
      mode: 0o600,
    });
  }

  load(): void {
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      const state: PersistedState = JSON.parse(data);
      this.nextInboxId = state.nextInboxId || 1;
      this.chats.clear();

      for (const chat of state.chats || []) {
        if (!chat.inbox) {
          chat.inbox = [];
        }
        this.chats.set(chat.projectId, chat);
      }
    } catch {
      // File doesn't exist or is invalid, start fresh
    }
  }

  private async findChatByName(name: string): Promise<string | null> {
    const result = await proc.run([
      'dws',
      'chat',
      '+chat-search',
      '--query',
      name,
      '-f',
      'json',
    ]);

    if (result.code !== 0) {
      return null;
    }

    try {
      const data = JSON.parse(result.stdout);
      const chats = data.chats || [];
      const match = chats.find((c: any) => c.name === name);
      return match?.openConversationId || null;
    } catch {
      return null;
    }
  }

  private async createChat(name: string): Promise<string> {
    const result = await proc.run([
      'dws',
      'chat',
      '+chat-create',
      '--name',
      name,
      '-f',
      'json',
      '--yes',
    ]);

    if (result.code !== 0) {
      throw new Error(`Failed to create chat: ${result.stderr}`);
    }

    const data = JSON.parse(result.stdout);
    if (!data.success) {
      throw new Error(`Failed to create chat: ${data.errorMsg}`);
    }

    return data.result.openConversationId;
  }
}
