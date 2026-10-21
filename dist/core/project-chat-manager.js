import * as proc from '../platform/proc.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as paths from '../platform/paths.js';
const STATE_FILE = 'project-chats.json';
const MAX_INBOX_SIZE = 100;
const CLAIM_LEASE_MS = 60_000;
export class ProjectChatManager {
    chats = new Map();
    nextInboxId = 1;
    filePath;
    sentContents = new Set();
    constructor(configDir) {
        const dir = configDir || paths.home();
        this.filePath = path.join(dir, STATE_FILE);
    }
    async getOrCreateChat(projectId, projectTitle) {
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
        const chat = {
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
    getProjectByChatId(chatId) {
        return Array.from(this.chats.values()).find((c) => c.chatId === chatId);
    }
    getChatByProjectId(projectId) {
        return this.chats.get(projectId);
    }
    getProjectByWorkdir(workdir) {
        const target = paths.resolveDir(workdir);
        return Array.from(this.chats.values()).find((c) => c.workdir && paths.resolveDir(c.workdir) === target);
    }
    setWorkdir(projectId, workdir) {
        const chat = this.chats.get(projectId);
        if (!chat)
            return;
        chat.workdir = workdir;
        this.save();
    }
    recordSentContent(content) {
        this.sentContents.add(ProjectChatManager.normalize(content));
        if (this.sentContents.size > 200) {
            const keep = Array.from(this.sentContents).slice(-100);
            this.sentContents = new Set(keep);
        }
    }
    wasSentByAgent(content) {
        const norm = ProjectChatManager.normalize(content);
        if (!norm)
            return false;
        if (this.sentContents.has(norm))
            return true;
        // DingTalk may reformat or truncate the echo; match containment only for
        // fragments long enough that a genuine user message cannot collide.
        if (norm.length < 20)
            return false;
        for (const sent of this.sentContents) {
            if (sent.length >= 20 && (sent.includes(norm) || norm.includes(sent))) {
                return true;
            }
        }
        return false;
    }
    static normalize(text) {
        return text.replace(/\s+/g, '');
    }
    listProjectChats() {
        return Array.from(this.chats.values());
    }
    addInboxMessage(projectId, senderId, content, timestamp) {
        const chat = this.chats.get(projectId);
        if (!chat)
            return;
        const message = {
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
    getUnreadMessages(projectId) {
        const chat = this.chats.get(projectId);
        if (!chat)
            return [];
        return chat.inbox.filter((m) => !m.read);
    }
    claimUnread(projectId) {
        const chat = this.chats.get(projectId);
        if (!chat)
            return [];
        const now = Date.now();
        // Two-phase delivery: claiming takes a short lease. The consumer must
        // acknowledge() or the message becomes claimable again, so a crashed
        // wrapper/hook cannot silently swallow phone instructions.
        const claimable = chat.inbox.filter((m) => !m.read && (!m.claimedAt || now - m.claimedAt > CLAIM_LEASE_MS));
        if (claimable.length === 0) {
            return claimable;
        }
        for (const msg of claimable) {
            msg.claimedAt = now;
        }
        this.save();
        return claimable;
    }
    acknowledge(projectId, ids) {
        const chat = this.chats.get(projectId);
        if (!chat)
            return;
        const set = new Set(ids);
        let changed = false;
        for (const msg of chat.inbox) {
            if (set.has(msg.id) && !msg.read) {
                msg.read = true;
                delete msg.claimedAt;
                changed = true;
            }
        }
        if (changed)
            this.save();
    }
    releaseLease(projectId, ids) {
        const chat = this.chats.get(projectId);
        if (!chat)
            return;
        const set = new Set(ids);
        let changed = false;
        for (const msg of chat.inbox) {
            if (set.has(msg.id) && msg.claimedAt !== undefined) {
                delete msg.claimedAt;
                changed = true;
            }
        }
        if (changed)
            this.save();
    }
    markAsRead(projectId) {
        const chat = this.chats.get(projectId);
        if (!chat)
            return;
        for (const msg of chat.inbox) {
            msg.read = true;
        }
        this.save();
    }
    getUnreadCount(projectId) {
        const chat = this.chats.get(projectId);
        if (!chat)
            return 0;
        return chat.inbox.filter((m) => !m.read).length;
    }
    save() {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        const state = {
            nextInboxId: this.nextInboxId,
            chats: Array.from(this.chats.values()),
        };
        // Write-then-rename: a crash mid-save can never leave a truncated state file.
        const tmp = `${this.filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, this.filePath);
    }
    load() {
        let data;
        try {
            data = fs.readFileSync(this.filePath, 'utf8');
        }
        catch {
            return; // No state file yet: start fresh.
        }
        try {
            const state = JSON.parse(data);
            this.nextInboxId = state.nextInboxId || 1;
            this.chats.clear();
            for (const chat of state.chats || []) {
                if (!chat.inbox) {
                    chat.inbox = [];
                }
                this.chats.set(chat.projectId, chat);
            }
        }
        catch {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const dest = `${this.filePath}.corrupt-${stamp}`;
            try {
                fs.renameSync(this.filePath, dest);
            }
            catch {
                /* best effort */
            }
            console.warn(`project-chats.json was unreadable and could not be parsed; preserved at ${dest}, starting fresh.`);
            this.chats.clear();
            this.nextInboxId = 1;
        }
    }
    async findChatByName(name) {
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
            const match = chats.find((c) => c.name === name);
            return match?.openConversationId || null;
        }
        catch {
            return null;
        }
    }
    async createChat(name) {
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
//# sourceMappingURL=project-chat-manager.js.map