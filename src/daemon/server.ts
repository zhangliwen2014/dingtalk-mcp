import { Switch } from '../core/switch.js';
import { Registry } from '../core/registry.js';
import { DingTransport } from '../transport/ding-transport.js';
import { ProjectChatManager } from '../core/project-chat-manager.js';
import { route } from '../core/router.js';
import { BlockedReason } from '../core/errors.js';
import type { AgentRunner, RunnerProject } from './agent-runner.js';
import type { SessionRegistry } from './session-registry.js';
import * as net from 'net';
import * as fs from 'fs';

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
}

export class DaemonServer {
  private server: net.Server | null = null;
  private transport: DingTransport;
  private switch: Switch;
  readonly registry: Registry;
  private ipcEndpoint: string;
  private projectChatManager?: ProjectChatManager;
  private onChatCreated?: (chatId: string) => void;
  private agentRunner?: Pick<AgentRunner, 'enqueue'>;
  private sessionRegistry?: Pick<SessionRegistry, 'isActive' | 'ping' | 'leave'>;
  private headlessEnabled: boolean;

  constructor(options: DaemonServerOptions) {
    this.transport = options.transport;
    this.switch = options.switch;
    this.registry = options.registry;
    this.ipcEndpoint = options.ipcEndpoint;
    this.projectChatManager = options.projectChatManager;
    this.onChatCreated = options.onChatCreated;
    this.agentRunner = options.agentRunner;
    this.sessionRegistry = options.sessionRegistry;
    this.headlessEnabled = options.headlessEnabled ?? false;
  }

  async start(): Promise<void> {
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

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          if (fs.existsSync(this.ipcEndpoint)) {
            fs.unlinkSync(this.ipcEndpoint);
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  async rpc(method: string, params: any): Promise<any> {
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
      case 'hook_mirror':
        return this.handleHookMirror(params);
      default:
        throw new Error(`Unknown RPC method: ${method}`);
    }
  }

  private async handleHello(params: { version: string }): Promise<any> {
    return {
      ok: true,
      version: '1.0.0',
      instanceId: this.registry.instanceId,
    };
  }

  private async handleAsk(params: {
    question: string;
    target?: string;
    project_id?: string;
    project_title?: string;
    cwd?: string;
  }): Promise<any> {
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

  private async handleProjectAsk(
    params: {
      question: string;
      project_id?: string;
      project_title?: string;
      cwd?: string;
    },
    id: number
  ): Promise<any> {
    const projectId = params.project_id!;
    const projectTitle = params.project_title || projectId;

    const projectChat = await this.projectChatManager!.getOrCreateChat(
      projectId,
      projectTitle
    );

    if (params.cwd) {
      this.projectChatManager!.setWorkdir(projectId, params.cwd);
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
      id,
      chatId: projectChat.chatId,
    };
  }

  private async handleLegacyAsk(
    params: {
      question: string;
      target?: string;
    },
    id: number
  ): Promise<any> {
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
      id,
    };
  }

  private async handleCheck(params: { id: number }): Promise<any> {
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

  private async handleCancel(params: { id: number }): Promise<any> {
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

  private async handleStatus(params: {}): Promise<any> {
    const enabled = await this.switch.get();
    const pending = this.registry.listPending();

    return {
      ok: true,
      enabled,
      pendingCount: pending.length,
    };
  }

  private async handleSetSwitch(params: { enabled: boolean }): Promise<any> {
    await this.switch.set(params.enabled);
    return { ok: true };
  }

  private async handleIngest(params: { text: string }): Promise<any> {
    const pending = this.registry.listPending();
    const result = route(params.text, pending);

    if (result.kind === 'command') {
      if (result.cmd === 'enable') {
        await this.switch.set(true);
      } else if (result.cmd === 'disable') {
        await this.switch.set(false);
      } else if (result.cmd === 'cancel' && result.targetId !== undefined) {
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
      return { ok: true, routed: 'answer', id: result.id };
    }

    if (result.kind === 'ambiguous') {
      return { ok: false, error: 'ambiguous', routed: 'none' };
    }

    return { ok: true, routed: 'none' };
  }

  async handleChatMessage(params: {
    chatId: string;
    content: string;
    senderId?: string;
  }): Promise<any> {
    if (!this.projectChatManager) {
      return { ok: false, error: 'no project chat manager' };
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
      this.projectChatManager.addInboxMessage(
        projectChat.projectId,
        params.senderId || 'unknown',
        params.content,
        Date.now()
      );

      const workdir = projectChat.workdir;

      if (workdir && this.sessionRegistry?.isActive(workdir)) {
        await this.sendNotice(
          params.chatId,
          '已收到，将在电脑端 Agent 下一个动作时处理。'
        );
        return {
          ok: true,
          stored: 'inbox',
          projectId: projectChat.projectId,
          delivered: 'session',
        };
      }

      if (workdir && this.headlessEnabled && this.agentRunner) {
        const runnerProject: RunnerProject = {
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
        await this.sendNotice(
          params.chatId,
          '该项目的 qodercli 在电脑上未启动，消息已存收件箱。'
        );
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

    return { ok: true, id: pendingQuestion.id };
  }

  private async sendAck(chatId: string): Promise<void> {
    const ack = '已收到你的消息，Agent 稍后回复。';
    await this.sendNotice(chatId, ack);
  }

  private async sendNotice(chatId: string, text: string): Promise<void> {
    try {
      this.projectChatManager?.recordSentContent(text);
      await this.transport.sendToGroupChat(chatId, text);
    } catch (err) {
      console.error('Failed to send notice:', err);
    }
  }

  private handleHookPing(params: { session_id: string; cwd: string }): any {
    this.sessionRegistry?.ping(params.session_id, params.cwd);
    return { ok: true };
  }

  private handleHookLeave(params: { session_id: string }): any {
    this.sessionRegistry?.leave(params.session_id);
    return { ok: true };
  }

  private handleHookPoll(params: { cwd: string }): any {
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

  private async handleHookMirror(params: {
    cwd: string;
    content: string;
  }): Promise<any> {
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

  private async handleReplyToProject(params: { project_id: string; content: string }): Promise<any> {
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

  private async handleReadProjectMessages(params: { project_id: string }): Promise<any> {
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

  private async handleListProjectInboxes(params: {}): Promise<any> {
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
        unreadCount: this.projectChatManager!.getUnreadCount(p.projectId),
      })),
    };
  }

  private async handleListProjects(params: {}): Promise<any> {
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

  private handleConnection(socket: net.Socket): void {
    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          try {
            const request = JSON.parse(line);
            this.handleRequest(socket, request);
          } catch (err) {
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

  private async handleRequest(
    socket: net.Socket,
    request: { id: number; method: string; params: any }
  ): Promise<void> {
    try {
      const result = await this.rpc(request.method, request.params);
      const response = { id: request.id, ...result };
      socket.write(JSON.stringify(response) + '\n');
    } catch (err) {
      const response = {
        id: request.id,
        ok: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
      socket.write(JSON.stringify(response) + '\n');
    }
  }
}
