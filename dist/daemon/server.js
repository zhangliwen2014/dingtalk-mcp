import { route } from '../core/router.js';
import { BlockedReason } from '../core/errors.js';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'node:path';
export class DaemonServer {
    server = null;
    sockets = new Set();
    transport;
    switch;
    registry;
    ipcEndpoint;
    projectChatManager;
    onChatCreated;
    agentRunner;
    sessionRegistry;
    headlessEnabled;
    allowedSenderIds;
    constructor(options) {
        this.transport = options.transport;
        this.switch = options.switch;
        this.registry = options.registry;
        this.ipcEndpoint = options.ipcEndpoint;
        this.projectChatManager = options.projectChatManager;
        this.onChatCreated = options.onChatCreated;
        this.agentRunner = options.agentRunner;
        this.sessionRegistry = options.sessionRegistry;
        this.headlessEnabled = options.headlessEnabled ?? false;
        this.allowedSenderIds =
            options.allowedSenderIds && options.allowedSenderIds.length > 0
                ? options.allowedSenderIds
                : undefined;
    }
    async start() {
        if (fs.existsSync(this.ipcEndpoint)) {
            fs.unlinkSync(this.ipcEndpoint);
        }
        return new Promise((resolve) => {
            this.server = net.createServer((socket) => {
                this.handleConnection(socket);
            });
            this.server.listen(this.ipcEndpoint, () => {
                resolve();
            });
        });
    }
    async stop() {
        return new Promise((resolve) => {
            if (!this.server) {
                resolve();
                return;
            }
            // net.Server.close() waits for existing connections; long-lived IPC
            // clients would hang shutdown forever, so drop them explicitly.
            for (const s of this.sockets)
                s.destroy();
            this.sockets.clear();
            this.server.close(() => {
                if (fs.existsSync(this.ipcEndpoint)) {
                    fs.unlinkSync(this.ipcEndpoint);
                }
                resolve();
            });
        });
    }
    async rpc(method, params) {
        switch (method) {
            case 'hello':
                return this.handleHello(params);
            case 'ask':
                return this.handleAsk(params);
            case 'check':
                return this.handleCheck(params);
            case 'cancel':
                return this.handleCancel(params);
            case 'status':
                return this.handleStatus(params);
            case 'set_switch':
                return this.handleSetSwitch(params);
            case 'reply':
            case 'ingest':
                return this.handleIngest(params);
            case 'chat_message':
                return this.handleChatMessage(params);
            case 'list_projects':
                return this.handleListProjects(params);
            case 'read_project_messages':
                return this.handleReadProjectMessages(params);
            case 'list_project_inboxes':
                return this.handleListProjectInboxes(params);
            case 'reply_to_project':
                return this.handleReplyToProject(params);
            case 'hook_ping':
                return this.handleHookPing(params);
            case 'hook_leave':
                return this.handleHookLeave(params);
            case 'hook_poll':
                return this.handleHookPoll(params);
            case 'hook_register':
                return this.handleHookRegister(params);
            case 'hook_ack':
                return this.handleHookAck(params);
            case 'hook_unclaim':
                return this.handleHookUnclaim(params);
            case 'hook_mirror':
                return this.handleHookMirror(params);
            default:
                throw new Error(`Unknown RPC method: ${method}`);
        }
    }
    async handleHello(params) {
        return {
            ok: true,
            version: '1.0.0',
            instanceId: this.registry.instanceId,
        };
    }
    async handleAsk(params) {
        const enabled = await this.switch.get();
        if (!enabled) {
            return {
                ok: true,
                status: 'blocked',
                reason: BlockedReason.DISABLED,
            };
        }
        const id = this.registry.allocateId();
        if (this.projectChatManager && params.project_id) {
            return this.handleProjectAsk(params, id);
        }
        return this.handleLegacyAsk(params, id);
    }
    async handleProjectAsk(params, id) {
        const projectId = params.project_id;
        const projectTitle = params.project_title || projectId;
        const projectChat = await this.projectChatManager.getOrCreateChat(projectId, projectTitle);
        if (params.cwd) {
            this.projectChatManager.setWorkdir(projectId, params.cwd);
        }
        const isNewChat = projectChat.questionIds.length === 0;
        const question = this.registry.add({
            id,
            text: params.question,
            target: projectChat.chatId,
        });
        projectChat.questionIds.push(id);
        const message = `Q${id}: ${params.question}`;
        await this.transport.sendToGroupChat(projectChat.chatId, message);
        this.registry.save();
        if (isNewChat && this.onChatCreated) {
            this.onChatCreated(projectChat.chatId);
        }
        return {
            ok: true,
            status: 'pending',
            questionId: id,
            chatId: projectChat.chatId,
        };
    }
    async handleLegacyAsk(params, id) {
        const target = params.target || 'self';
        const targetId = await this.transport.resolveTarget(target);
        const question = this.registry.add({
            id,
            text: params.question,
            target: targetId,
        });
        const message = `#Q${id}: ${params.question}`;
        await this.transport.sendText(targetId, message);
        this.registry.save();
        return {
            ok: true,
            status: 'pending',
            questionId: id,
        };
    }
    async handleCheck(params) {
        const question = this.registry.get(params.id);
        if (!question) {
            throw new Error(`Question ${params.id} not found`);
        }
        if (question.status === 'answered') {
            return {
                ok: true,
                status: 'answered',
                answer: question.answer,
                answeredVia: question.answeredVia,
            };
        }
        return {
            ok: true,
            status: question.status,
        };
    }
    async handleCancel(params) {
        const question = this.registry.get(params.id);
        if (!question) {
            throw new Error(`Question ${params.id} not found`);
        }
        question.cancel();
        this.registry.save();
        return {
            ok: true,
            status: 'cancelled',
        };
    }
    async handleStatus(params) {
        const enabled = await this.switch.get();
        const pending = this.registry.listPending();
        return {
            ok: true,
            enabled,
            pendingCount: pending.length,
        };
    }
    async handleSetSwitch(params) {
        await this.switch.set(params.enabled);
        return { ok: true };
    }
    async handleIngest(params) {
        const pending = this.registry.listPending();
        const result = route(params.text, pending);
        if (result.kind === 'command') {
            if (result.cmd === 'enable') {
                await this.switch.set(true);
            }
            else if (result.cmd === 'disable') {
                await this.switch.set(false);
            }
            else if (result.cmd === 'cancel' && result.targetId !== undefined) {
                const q = this.registry.get(result.targetId);
                if (q) {
                    q.cancel();
                    this.registry.save();
                }
            }
            return { ok: true, routed: 'command' };
        }
        if (result.kind === 'answer') {
            const question = this.registry.get(result.id);
            if (question) {
                question.accept(result.text, 'phone');
                this.registry.save();
            }
            return { ok: true, routed: 'answer', questionId: result.id };
        }
        if (result.kind === 'ambiguous') {
            return { ok: false, error: 'ambiguous', routed: 'none' };
        }
        return { ok: true, routed: 'none' };
    }
    async handleChatMessage(params) {
        if (!this.projectChatManager) {
            return { ok: false, error: 'no project chat manager' };
        }
        // Group messages act as PC keyboard input; only whitelisted senders may drive the agent.
        if (this.allowedSenderIds) {
            if (!params.senderId || !this.allowedSenderIds.includes(params.senderId)) {
                return { ok: true, ignored: 'unauthorized' };
            }
        }
        if (this.projectChatManager.wasSentByAgent(params.content)) {
            return { ok: true, ignored: 'self' };
        }
        const projectChat = this.projectChatManager.getProjectByChatId(params.chatId);
        if (!projectChat) {
            return { ok: false, error: 'unknown chat' };
        }
        const pendingQuestion = projectChat.questionIds
            .map((id) => this.registry.get(id))
            .filter((q) => q && q.status === 'pending')
            .pop();
        if (!pendingQuestion) {
            this.projectChatManager.addInboxMessage(projectChat.projectId, params.senderId || 'unknown', params.content, Date.now());
            const workdir = projectChat.workdir;
            if (workdir && this.sessionRegistry?.isActive(workdir)) {
                await this.sendNotice(params.chatId, '已收到，将在电脑端 Agent 下一个动作时处理。');
                return {
                    ok: true,
                    stored: 'inbox',
                    projectId: projectChat.projectId,
                    delivered: 'session',
                };
            }
            if (workdir && this.headlessEnabled && this.agentRunner) {
                const runnerProject = {
                    projectId: projectChat.projectId,
                    projectTitle: projectChat.projectTitle,
                    chatId: projectChat.chatId,
                    workdir,
                };
                this.agentRunner.enqueue(runnerProject, params.content);
                return {
                    ok: true,
                    stored: 'inbox',
                    projectId: projectChat.projectId,
                    dispatched: 'agent',
                };
            }
            if (workdir) {
                await this.sendNotice(params.chatId, '该项目的 qodercli 在电脑上未启动，消息已存收件箱。');
                return {
                    ok: true,
                    stored: 'inbox',
                    projectId: projectChat.projectId,
                    delivered: 'queued',
                };
            }
            await this.sendAck(params.chatId);
            return { ok: true, stored: 'inbox', projectId: projectChat.projectId };
        }
        pendingQuestion.accept(params.content, 'phone');
        this.registry.save();
        await this.sendAck(params.chatId);
        return { ok: true, questionId: pendingQuestion.id };
    }
    async sendAck(chatId) {
        const ack = '已收到你的消息，Agent 稍后回复。';
        await this.sendNotice(chatId, ack);
    }
    async sendNotice(chatId, text) {
        try {
            this.projectChatManager?.recordSentContent(text);
            await this.transport.sendToGroupChat(chatId, text);
        }
        catch (err) {
            console.error('Failed to send notice:', err);
        }
    }
    handleHookPing(params) {
        this.sessionRegistry?.ping(params.session_id, params.cwd);
        return { ok: true };
    }
    handleHookLeave(params) {
        this.sessionRegistry?.leave(params.session_id);
        return { ok: true };
    }
    handleHookPoll(params) {
        if (!this.projectChatManager) {
            return { ok: true, messages: [] };
        }
        const chat = this.projectChatManager.getProjectByWorkdir(params.cwd);
        if (!chat) {
            return { ok: true, messages: [] };
        }
        const claimed = this.projectChatManager.claimUnread(chat.projectId);
        return {
            ok: true,
            projectId: chat.projectId,
            messages: claimed.map((m) => ({
                id: m.id,
                content: m.content,
                senderId: m.senderId,
                timestamp: m.timestamp,
            })),
        };
    }
    async handleHookRegister(params) {
        if (!this.projectChatManager) {
            return { ok: false, error: 'no project chat manager' };
        }
        if (!params.cwd) {
            return { ok: false, error: 'cwd required' };
        }
        const existing = this.projectChatManager.getProjectByWorkdir(params.cwd);
        if (existing) {
            return {
                ok: true,
                projectId: existing.projectId,
                chatId: existing.chatId,
                created: false,
            };
        }
        const projectId = path.basename(params.cwd.replace(/[\\/]+$/, '')) || 'project';
        const chat = await this.projectChatManager.getOrCreateChat(projectId, projectId);
        this.projectChatManager.setWorkdir(chat.projectId, params.cwd);
        this.onChatCreated?.(chat.chatId);
        return {
            ok: true,
            projectId: chat.projectId,
            chatId: chat.chatId,
            created: true,
        };
    }
    handleHookAck(params) {
        const chat = this.projectChatManager?.getProjectByWorkdir(params.cwd);
        if (chat && this.projectChatManager) {
            this.projectChatManager.acknowledge(chat.projectId, params.ids ?? []);
        }
        return { ok: true };
    }
    handleHookUnclaim(params) {
        const chat = this.projectChatManager?.getProjectByWorkdir(params.cwd);
        if (chat && this.projectChatManager) {
            this.projectChatManager.releaseLease(chat.projectId, params.ids ?? []);
        }
        return { ok: true };
    }
    async handleHookMirror(params) {
        if (!this.projectChatManager) {
            return { ok: true, mirrored: false };
        }
        const chat = this.projectChatManager.getProjectByWorkdir(params.cwd);
        if (!chat) {
            return { ok: true, mirrored: false };
        }
        const enabled = await this.switch.get();
        if (!enabled) {
            return { ok: true, mirrored: false };
        }
        const content = (params.content || '').trim();
        if (!content) {
            return { ok: true, mirrored: false };
        }
        if (this.projectChatManager.wasSentByAgent(content)) {
            return { ok: true, mirrored: false };
        }
        this.projectChatManager.recordSentContent(content);
        await this.transport.sendToGroupChat(chat.chatId, content);
        return { ok: true, mirrored: true };
    }
    async handleReplyToProject(params) {
        if (!this.projectChatManager) {
            return { ok: false, error: 'no project chat manager' };
        }
        const chat = this.projectChatManager.getChatByProjectId(params.project_id);
        if (!chat) {
            return { ok: false, error: 'no chat for project' };
        }
        this.projectChatManager.recordSentContent(params.content);
        await this.transport.sendToGroupChat(chat.chatId, params.content);
        return { ok: true, chatId: chat.chatId };
    }
    async handleReadProjectMessages(params) {
        if (!this.projectChatManager) {
            return { ok: false, error: 'no project chat manager' };
        }
        const messages = this.projectChatManager.getUnreadMessages(params.project_id);
        this.projectChatManager.markAsRead(params.project_id);
        return {
            ok: true,
            projectId: params.project_id,
            messages,
        };
    }
    async handleListProjectInboxes(params) {
        if (!this.projectChatManager) {
            return { ok: false, error: 'no project chat manager' };
        }
        const projects = this.projectChatManager.listProjectChats();
        return {
            ok: true,
            projects: projects.map((p) => ({
                projectId: p.projectId,
                projectTitle: p.projectTitle,
                chatId: p.chatId,
                unreadCount: this.projectChatManager.getUnreadCount(p.projectId),
            })),
        };
    }
    async handleListProjects(params) {
        if (!this.projectChatManager) {
            return { ok: false, error: 'no project chat manager' };
        }
        const projects = this.projectChatManager.listProjectChats();
        return {
            ok: true,
            projects: projects.map((p) => ({
                projectId: p.projectId,
                projectTitle: p.projectTitle,
                chatId: p.chatId,
                questionCount: p.questionIds.length,
            })),
        };
    }
    handleConnection(socket) {
        let buffer = '';
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('error', () => this.sockets.delete(socket));
        socket.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (line.trim()) {
                    try {
                        const request = JSON.parse(line);
                        this.handleRequest(socket, request);
                    }
                    catch (err) {
                        const response = {
                            ok: false,
                            error: err instanceof Error ? err.message : 'Unknown error',
                        };
                        socket.write(JSON.stringify(response) + '\n');
                    }
                }
            }
        });
    }
    async handleRequest(socket, request) {
        try {
            const result = await this.rpc(request.method, request.params);
            const response = { ...result, id: request.id };
            socket.write(JSON.stringify(response) + '\n');
        }
        catch (err) {
            const response = {
                id: request.id,
                ok: false,
                error: err instanceof Error ? err.message : 'Unknown error',
            };
            socket.write(JSON.stringify(response) + '\n');
        }
    }
}
//# sourceMappingURL=server.js.map