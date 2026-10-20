import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DaemonServer } from './server.js';
import { IpcClient } from './client.js';
import { FakeTransport } from '../transport/fake-transport.js';
import { Switch } from '../core/switch.js';
import { Registry } from '../core/registry.js';
import { QuestionStatus } from '../core/question.js';
import { ProjectChatManager } from '../core/project-chat-manager.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';

describe('DaemonServer', () => {
  let tempDir: string;
  let transport: FakeTransport;
  let switchControl: Switch;
  let registry: Registry;
  let server: DaemonServer;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtmcp-daemon-test-'));
    transport = new FakeTransport();
    switchControl = new Switch(tempDir);
    registry = new Registry(tempDir);

    server = new DaemonServer({
      transport,
      switch: switchControl,
      registry,
      ipcEndpoint: path.join(tempDir, 'test.sock'),
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('hello', () => {
    it('returns version and instance info', async () => {
      const result = await server.rpc('hello', { version: '1.0.0' });
      expect(result).toMatchObject({
        ok: true,
        version: expect.any(String),
      });
    });
  });

  describe('shutdown', () => {
    it('stop() terminates active connections instead of hanging on them', async () => {
      const sock = net.connect(path.join(tempDir, 'test.sock'));
      await new Promise((res) => sock.once('connect', res));

      const outcome = await Promise.race([
        server.stop().then(() => 'stopped'),
        new Promise((res) => setTimeout(() => res('timeout'), 1000)),
      ]);
      expect(outcome).toBe('stopped');

      const closed = await Promise.race([
        new Promise((res) => sock.once('close', () => res('closed'))),
        new Promise((res) => setTimeout(() => res('open'), 500)),
      ]);
      expect(closed).toBe('closed');
      sock.destroy();
    });
  });

  describe('socket correlation id', () => {
    function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
      return Promise.race([
        p,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('RPC timed out')), ms)
        ),
      ]);
    }

    it('resolves a socket request whose handler returns a business id', async () => {
      await switchControl.set(true);
      transport.setResolveTargetResult('user123');

      const client = new IpcClient(path.join(tempDir, 'test.sock'));
      await client.connect();
      try {
        // Consume requestId 1 so the ask request carries correlation id 2,
        // distinct from the business question id 1.
        await client.request('hello', { version: '1.0.0' });

        const result = await withTimeout(
          client.request('ask', { question: 'Q?', target: 'self' }),
          2000
        );
        expect(result).toMatchObject({
          ok: true,
          status: 'pending',
          id: 2,
          questionId: 1,
        });
      } finally {
        await client.disconnect();
      }
    });
  });

  describe('ask (disabled)', () => {
    it('returns blocked when switch is off', async () => {
      await switchControl.set(false);

      const result = await server.rpc('ask', {
        question: 'Test question?',
        target: 'self',
      });

      expect(result).toMatchObject({
        ok: true,
        status: 'blocked',
        reason: 'disabled',
      });
      expect(transport.sentMessages).toHaveLength(0);
    });
  });

  describe('ask (enabled, single question)', () => {
    beforeEach(async () => {
      await switchControl.set(true);
      transport.setResolveTargetResult('user123');
    });

    it('allocates ID, sends to DingTalk, returns pending', async () => {
      const result = await server.rpc('ask', {
        question: '保留备份还是删除?',
        target: 'self',
      });

      expect(result).toMatchObject({
        ok: true,
        status: 'pending',
        questionId: 1,
      });

      expect(transport.sentMessages).toHaveLength(1);
      expect(transport.sentMessages[0]).toMatchObject({
        target: 'user123',
        text: expect.stringContaining('#Q1: 保留备份还是删除?'),
      });
    });

    it('allocates monotonic IDs', async () => {
      const r1 = await server.rpc('ask', { question: 'Q1?', target: 'self' });
      const r2 = await server.rpc('ask', { question: 'Q2?', target: 'self' });

      expect(r1.questionId).toBe(1);
      expect(r2.questionId).toBe(2);
      expect(transport.sentMessages).toHaveLength(2);
    });
  });

  describe('check', () => {
    beforeEach(async () => {
      await switchControl.set(true);
      transport.setResolveTargetResult('user123');
    });

    it('returns answered when question has answer', async () => {
      const askResult = await server.rpc('ask', {
        question: 'Test?',
        target: 'self',
      });
      const id = askResult.questionId;

      await server.rpc('reply', { text: `#Q${id}: 答案` });

      const checkResult = await server.rpc('check', { id });
      expect(checkResult).toMatchObject({
        ok: true,
        status: 'answered',
        answer: '答案',
        answeredVia: 'phone',
      });
    });

    it('returns pending when no answer yet', async () => {
      const askResult = await server.rpc('ask', {
        question: 'Test?',
        target: 'self',
      });

      const checkResult = await server.rpc('check', { id: askResult.questionId });
      expect(checkResult).toMatchObject({
        ok: true,
        status: 'pending',
      });
    });
  });

  describe('cancel', () => {
    beforeEach(async () => {
      await switchControl.set(true);
      transport.setResolveTargetResult('user123');
    });

    it('cancels pending question', async () => {
      const askResult = await server.rpc('ask', {
        question: 'Test?',
        target: 'self',
      });

      const cancelResult = await server.rpc('cancel', { id: askResult.questionId });
      expect(cancelResult).toMatchObject({
        ok: true,
        status: 'cancelled',
      });

      const checkResult = await server.rpc('check', { id: askResult.questionId });
      expect(checkResult.status).toBe('cancelled');
    });
  });

  describe('status', () => {
    it('returns switch state and pending count', async () => {
      await switchControl.set(true);
      transport.setResolveTargetResult('user123');

      await server.rpc('ask', { question: 'Q1?', target: 'self' });
      await server.rpc('ask', { question: 'Q2?', target: 'self' });

      const result = await server.rpc('status', {});
      expect(result).toMatchObject({
        ok: true,
        enabled: true,
        pendingCount: 2,
      });
    });
  });

  describe('set_switch', () => {
    it('toggles switch on/off', async () => {
      await server.rpc('set_switch', { enabled: true });
      expect(await switchControl.get()).toBe(true);

      await server.rpc('set_switch', { enabled: false });
      expect(await switchControl.get()).toBe(false);
    });
  });

  describe('ingest (phone reply)', () => {
    beforeEach(async () => {
      await switchControl.set(true);
      transport.setResolveTargetResult('user123');
    });

    it('routes reply with explicit ID to correct question', async () => {
      await server.rpc('ask', { question: 'Q1?', target: 'self' });
      const r2 = await server.rpc('ask', { question: 'Q2?', target: 'self' });

      await server.rpc('ingest', { text: `#Q${r2.questionId}: 选Q2` });

      const check = await server.rpc('check', { id: r2.questionId });
      expect(check).toMatchObject({
        ok: true,
        status: 'answered',
        answer: '选Q2',
      });
    });

    it('routes reply to single pending question', async () => {
      await server.rpc('ask', { question: 'Only one?', target: 'self' });

      await server.rpc('ingest', { text: '答案' });

      const check = await server.rpc('check', { id: 1 });
      expect(check).toMatchObject({
        ok: true,
        status: 'answered',
        answer: '答案',
      });
    });

    it('handles #开 command', async () => {
      await switchControl.set(false);

      await server.rpc('ingest', { text: '#开' });

      expect(await switchControl.get()).toBe(true);
    });

    it('handles #关 command', async () => {
      await switchControl.set(true);

      await server.rpc('ingest', { text: '#关' });

      expect(await switchControl.get()).toBe(false);
    });

    it('handles #忽略 command', async () => {
      const askResult = await server.rpc('ask', {
        question: 'Test?',
        target: 'self',
      });

      await server.rpc('ingest', { text: `#忽略${askResult.questionId}` });

      const check = await server.rpc('check', { id: askResult.questionId });
      expect(check.status).toBe('cancelled');
    });
  });

  describe('ask (project-based)', () => {
    let projectChatManager: ProjectChatManager;
    let projectServer: DaemonServer;
    let onChatCreated: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      await switchControl.set(true);
      projectChatManager = new ProjectChatManager();
      onChatCreated = vi.fn();

      vi.spyOn(projectChatManager, 'getOrCreateChat').mockResolvedValue({
        projectId: 'proj-1',
        projectTitle: '官网重构',
        chatId: 'chat-abc',
        questionIds: [],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        inbox: [],
      });

      projectServer = new DaemonServer({
        transport,
        switch: switchControl,
        registry,
        ipcEndpoint: path.join(tempDir, 'test-proj.sock'),
        projectChatManager,
        onChatCreated,
      });
      await projectServer.start();
    });

    afterEach(async () => {
      await projectServer.stop();
      vi.restoreAllMocks();
    });

    it('creates project chat and sends to group', async () => {
      const result = await projectServer.rpc('ask', {
        question: '保留备份还是删除?',
        project_id: 'proj-1',
        project_title: '官网重构',
      });

      expect(result).toMatchObject({
        ok: true,
        status: 'pending',
        questionId: 1,
        chatId: 'chat-abc',
      });

      expect(transport.sentGroupMessages).toHaveLength(1);
      expect(transport.sentGroupMessages[0]).toMatchObject({
        chatId: 'chat-abc',
        text: 'Q1: 保留备份还是删除?',
      });
    });

    it('calls onChatCreated for new project chat', async () => {
      await projectServer.rpc('ask', {
        question: 'Test?',
        project_id: 'proj-1',
        project_title: '官网重构',
      });

      expect(onChatCreated).toHaveBeenCalledWith('chat-abc');
    });

    it('does not call onChatCreated for existing project chat', async () => {
      await projectServer.rpc('ask', {
        question: 'Q1?',
        project_id: 'proj-1',
        project_title: '官网重构',
      });
      onChatCreated.mockClear();

      await projectServer.rpc('ask', {
        question: 'Q2?',
        project_id: 'proj-1',
        project_title: '官网重构',
      });

      expect(onChatCreated).not.toHaveBeenCalled();
    });

    it('binds workdir when ask includes cwd', async () => {
      const spy = vi
        .spyOn(projectChatManager, 'setWorkdir')
        .mockImplementation(() => {});

      await projectServer.rpc('ask', {
        question: 'T?',
        project_id: 'proj-1',
        project_title: '官网重构',
        cwd: '/repo/x',
      });

      expect(spy).toHaveBeenCalledWith('proj-1', '/repo/x');
    });
  });

  describe('chat_message (project reply routing)', () => {
    let projectChatManager: ProjectChatManager;
    let projectServer: DaemonServer;

    beforeEach(async () => {
      await switchControl.set(true);
      projectChatManager = new ProjectChatManager();

      vi.spyOn(projectChatManager, 'getOrCreateChat').mockResolvedValue({
        projectId: 'proj-1',
        projectTitle: '官网重构',
        chatId: 'chat-abc',
        questionIds: [],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });

      vi.spyOn(projectChatManager, 'getProjectByChatId').mockReturnValue({
        projectId: 'proj-1',
        projectTitle: '官网重构',
        chatId: 'chat-abc',
        questionIds: [1],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        inbox: [],
      });

      projectServer = new DaemonServer({
        transport,
        switch: switchControl,
        registry,
        ipcEndpoint: path.join(tempDir, 'test-chat-msg.sock'),
        projectChatManager,
      });
      await projectServer.start();
    });

    afterEach(async () => {
      await projectServer.stop();
      vi.restoreAllMocks();
    });

    it('routes chat message to pending question', async () => {
      await projectServer.rpc('ask', {
        question: 'Test?',
        project_id: 'proj-1',
        project_title: '官网重构',
      });

      const result = await projectServer.handleChatMessage({
        chatId: 'chat-abc',
        content: '答案',
      });

      expect(result).toMatchObject({ ok: true, questionId: 1 });

      const check = await projectServer.rpc('check', { id: 1 });
      expect(check).toMatchObject({
        ok: true,
        status: 'answered',
        answer: '答案',
        answeredVia: 'phone',
      });
    });

    it('returns error for unknown chat', async () => {
      vi.spyOn(projectChatManager, 'getProjectByChatId').mockReturnValue(undefined);

      const result = await projectServer.handleChatMessage({
        chatId: 'unknown-chat',
        content: '答案',
      });

      expect(result).toMatchObject({ ok: false, error: 'unknown chat' });
    });
  });

  describe('list_projects', () => {
    it('returns project list', async () => {
      const projectChatManager = new ProjectChatManager();
      vi.spyOn(projectChatManager, 'listProjectChats').mockReturnValue([
        {
          projectId: 'proj-1',
          projectTitle: '官网重构',
          chatId: 'chat-abc',
          questionIds: [1, 2],
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          inbox: [],
        },
      ]);

      const projectServer = new DaemonServer({
        transport,
        switch: switchControl,
        registry,
        ipcEndpoint: path.join(tempDir, 'test-list.sock'),
        projectChatManager,
      });
      await projectServer.start();

      const result = await projectServer.rpc('list_projects', {});
      expect(result).toMatchObject({
        ok: true,
        projects: [
          {
            projectId: 'proj-1',
            projectTitle: '官网重构',
            chatId: 'chat-abc',
            questionCount: 2,
          },
        ],
      });

      await projectServer.stop();
      vi.restoreAllMocks();
    });
  });

  describe('chat_message (inbox storage)', () => {
    let projectChatManager: ProjectChatManager;
    let projectServer: DaemonServer;

    beforeEach(async () => {
      await switchControl.set(true);
      projectChatManager = new ProjectChatManager(tempDir);

      vi.spyOn(projectChatManager, 'getProjectByChatId').mockReturnValue({
        projectId: 'proj-1',
        projectTitle: '官网重构',
        chatId: 'chat-abc',
        questionIds: [],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        inbox: [],
      });

      projectServer = new DaemonServer({
        transport,
        switch: switchControl,
        registry,
        ipcEndpoint: path.join(tempDir, 'test-inbox.sock'),
        projectChatManager,
      });
      await projectServer.start();
    });

    afterEach(async () => {
      await projectServer.stop();
      vi.restoreAllMocks();
    });

    it('stores message in inbox when no pending question', async () => {
      const result = await projectServer.handleChatMessage({
        chatId: 'chat-abc',
        content: '主动消息',
        senderId: 'user1',
      });

      expect(result).toMatchObject({
        ok: true,
        stored: 'inbox',
        projectId: 'proj-1',
      });
    });

    it('sends acknowledgment to the group when a new proactive message arrives', async () => {
      await projectServer.handleChatMessage({
        chatId: 'chat-abc',
        content: '你好',
        senderId: 'user1',
      });

      expect(transport.sentGroupMessages.some((m) => m.chatId === 'chat-abc' && m.text.includes('已收到'))).toBe(true);
    });

    it('does not send acknowledgment for echoed self-sent content', async () => {
      projectChatManager.recordSentContent('已收到你的消息，Agent 稍后回复。');

      await projectServer.handleChatMessage({
        chatId: 'chat-abc',
        content: '已收到你的消息，Agent 稍后回复。',
        senderId: 'user1',
      });

      const ackCount = transport.sentGroupMessages.filter((m) => m.text.includes('已收到')).length;
      expect(ackCount).toBe(0);
    });

    it('read_project_messages returns unread messages', async () => {
      const messages = [
        { id: 1, senderId: 'user1', content: 'msg1', timestamp: Date.now(), read: false },
        { id: 2, senderId: 'user2', content: 'msg2', timestamp: Date.now(), read: false },
      ];
      vi.spyOn(projectChatManager, 'getUnreadMessages').mockReturnValue(messages);
      vi.spyOn(projectChatManager, 'markAsRead').mockImplementation(() => {});

      const result = await projectServer.rpc('read_project_messages', {
        project_id: 'proj-1',
      });

      expect(result).toMatchObject({
        ok: true,
        projectId: 'proj-1',
      });
      expect(result.messages).toHaveLength(2);
      expect(projectChatManager.markAsRead).toHaveBeenCalledWith('proj-1');
    });

    it('list_project_inboxes returns unread counts', async () => {
      const chatWithInbox = {
        projectId: 'proj-1',
        projectTitle: '官网重构',
        chatId: 'chat-abc',
        questionIds: [],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        inbox: [{ id: 1, senderId: 'user1', content: 'msg1', timestamp: Date.now(), read: false }],
      };
      vi.spyOn(projectChatManager, 'listProjectChats').mockReturnValue([chatWithInbox]);
      vi.spyOn(projectChatManager, 'getUnreadCount').mockReturnValue(1);

      const result = await projectServer.rpc('list_project_inboxes', {});

      expect(result).toMatchObject({
        ok: true,
        projects: expect.arrayContaining([
          expect.objectContaining({
            projectId: 'proj-1',
            unreadCount: 1,
          }),
        ]),
      });
    });
  });

  describe('chat_message (dual-channel inbox routing)', () => {
    let projectChatManager: ProjectChatManager;
    let runner: { enqueue: ReturnType<typeof vi.fn> };
    let sessionRegistry: { isActive: ReturnType<typeof vi.fn>; ping: ReturnType<typeof vi.fn>; leave: ReturnType<typeof vi.fn> };

    function mockChatWith(workdir?: string) {
      vi.spyOn(projectChatManager, 'getProjectByChatId').mockReturnValue({
        projectId: 'proj-1',
        projectTitle: '官网重构',
        chatId: 'chat-abc',
        questionIds: [],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        inbox: [],
        workdir,
      });
    }

    function makeServer(opts: { headless?: boolean; withRegistry?: boolean }) {
      const server = new DaemonServer({
        transport,
        switch: switchControl,
        registry,
        ipcEndpoint: path.join(tempDir, 'test-dc.sock'),
        projectChatManager,
        agentRunner: runner,
        headlessEnabled: opts.headless,
        sessionRegistry: opts.withRegistry === false ? undefined : sessionRegistry,
      });
      return server;
    }

    beforeEach(async () => {
      await switchControl.set(true);
      projectChatManager = new ProjectChatManager(tempDir);
      runner = { enqueue: vi.fn() };
      sessionRegistry = { isActive: vi.fn(() => false), ping: vi.fn(), leave: vi.fn() };

      vi.spyOn(projectChatManager, 'addInboxMessage').mockImplementation(() => {});
    });

    it('notifies the phone when a live PC session exists, without headless run', async () => {
      mockChatWith('/repo/p1');
      sessionRegistry.isActive.mockReturnValue(true);
      const server = makeServer({ headless: true });
      await server.start();

      const result = await server.handleChatMessage({
        chatId: 'chat-abc',
        content: '进展如何',
        senderId: 'user1',
      });

      expect(runner.enqueue).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true, stored: 'inbox', delivered: 'session' });
      expect(transport.sentGroupMessages.some((m) => m.text.includes('下一个动作'))).toBe(true);
      await server.stop();
    });

    it('dispatches to headless runner when no live session and headless enabled', async () => {
      mockChatWith('/repo/p1');
      sessionRegistry.isActive.mockReturnValue(false);
      const server = makeServer({ headless: true });
      await server.start();

      const result = await server.handleChatMessage({
        chatId: 'chat-abc',
        content: '进展如何',
        senderId: 'user1',
      });

      expect(runner.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'proj-1', workdir: '/repo/p1' }),
        '进展如何'
      );
      expect(result).toMatchObject({ ok: true, dispatched: 'agent' });
      await server.stop();
    });

    it('tells the phone the session is not started when headless is disabled (default)', async () => {
      mockChatWith('/repo/p1');
      const server = makeServer({ headless: false });
      await server.start();

      const result = await server.handleChatMessage({
        chatId: 'chat-abc',
        content: '继续',
        senderId: 'user1',
      });

      expect(runner.enqueue).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true, stored: 'inbox', delivered: 'queued' });
      expect(transport.sentGroupMessages.some((m) => m.text.includes('未启动'))).toBe(true);
      await server.stop();
    });

    it('keeps the legacy ack when workdir is missing', async () => {
      mockChatWith(undefined);
      const server = makeServer({ headless: true });
      await server.start();

      const result = await server.handleChatMessage({
        chatId: 'chat-abc',
        content: '进展如何',
        senderId: 'user1',
      });

      expect(runner.enqueue).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true, stored: 'inbox' });
      expect(transport.sentGroupMessages.some((m) => m.text.includes('已收到'))).toBe(true);
      await server.stop();
    });
  });

  describe('hook RPCs', () => {
    let projectChatManager: ProjectChatManager;
    let sessionRegistry: { isActive: ReturnType<typeof vi.fn>; ping: ReturnType<typeof vi.fn>; leave: ReturnType<typeof vi.fn> };
    let hookServer: DaemonServer;

    const chat = {
      projectId: 'proj-1',
      projectTitle: '官网重构',
      chatId: 'chat-abc',
      questionIds: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      inbox: [],
      workdir: '/repo/p1',
    };

    beforeEach(async () => {
      await switchControl.set(true);
      projectChatManager = new ProjectChatManager(tempDir);
      sessionRegistry = { isActive: vi.fn(() => false), ping: vi.fn(), leave: vi.fn() };

      hookServer = new DaemonServer({
        transport,
        switch: switchControl,
        registry,
        ipcEndpoint: path.join(tempDir, 'test-hook.sock'),
        projectChatManager,
        sessionRegistry,
      });
      await hookServer.start();
    });

    afterEach(async () => {
      await hookServer.stop();
      vi.restoreAllMocks();
    });

    it('hook_ping registers activity for session and cwd', async () => {
      const result = await hookServer.rpc('hook_ping', {
        session_id: 's1',
        cwd: '/repo/p1',
      });

      expect(result).toMatchObject({ ok: true });
      expect(sessionRegistry.ping).toHaveBeenCalledWith('s1', '/repo/p1');
    });

    it('hook_leave removes the session', async () => {
      await hookServer.rpc('hook_leave', { session_id: 's1' });
      expect(sessionRegistry.leave).toHaveBeenCalledWith('s1');
    });

    it('hook_poll claims unread messages for the cwd project', async () => {
      vi.spyOn(projectChatManager, 'getProjectByWorkdir').mockReturnValue(chat);
      vi.spyOn(projectChatManager, 'claimUnread').mockReturnValue([
        { id: 1, senderId: 'u1', content: '手机指令', timestamp: 100, read: true },
      ]);

      const result = await hookServer.rpc('hook_poll', { cwd: '/repo/p1' });

      expect(projectChatManager.claimUnread).toHaveBeenCalledWith('proj-1');
      expect(result).toMatchObject({ ok: true, projectId: 'proj-1' });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toMatchObject({ content: '手机指令', senderId: 'u1' });
    });

    it('hook_poll returns no messages for unknown cwd', async () => {
      vi.spyOn(projectChatManager, 'getProjectByWorkdir').mockReturnValue(undefined);

      const result = await hookServer.rpc('hook_poll', { cwd: '/nowhere' });

      expect(result).toMatchObject({ ok: true, messages: [] });
    });

    it('hook_mirror pushes final reply to the group and records it', async () => {
      vi.spyOn(projectChatManager, 'getProjectByWorkdir').mockReturnValue(chat);
      const record = vi.spyOn(projectChatManager, 'recordSentContent').mockImplementation(() => {});

      const result = await hookServer.rpc('hook_mirror', {
        cwd: '/repo/p1',
        content: '任务已完成 80%',
      });

      expect(result).toMatchObject({ ok: true, mirrored: true });
      expect(record).toHaveBeenCalledWith('任务已完成 80%');
      expect(transport.sentGroupMessages.some((m) => m.text === '任务已完成 80%')).toBe(true);
    });

    it('hook_mirror skips when the switch is off', async () => {
      await switchControl.set(false);
      vi.spyOn(projectChatManager, 'getProjectByWorkdir').mockReturnValue(chat);

      const result = await hookServer.rpc('hook_mirror', { cwd: '/repo/p1', content: 'x' });

      expect(result).toMatchObject({ ok: true, mirrored: false });
      expect(transport.sentGroupMessages).toHaveLength(0);
    });

    it('hook_mirror skips content already sent by the agent', async () => {
      vi.spyOn(projectChatManager, 'getProjectByWorkdir').mockReturnValue(chat);
      vi.spyOn(projectChatManager, 'wasSentByAgent').mockReturnValue(true);

      const result = await hookServer.rpc('hook_mirror', { cwd: '/repo/p1', content: '回声' });

      expect(result).toMatchObject({ ok: true, mirrored: false });
      expect(transport.sentGroupMessages).toHaveLength(0);
    });

    it('hook_mirror skips unknown project', async () => {
      vi.spyOn(projectChatManager, 'getProjectByWorkdir').mockReturnValue(undefined);

      const result = await hookServer.rpc('hook_mirror', { cwd: '/nowhere', content: 'y' });

      expect(result).toMatchObject({ ok: true, mirrored: false });
    });

    it('hook_ack marks claimed messages delivered', async () => {
      vi.spyOn(projectChatManager, 'getProjectByWorkdir').mockReturnValue(chat);
      const ack = vi
        .spyOn(projectChatManager, 'acknowledge')
        .mockImplementation(() => {});

      const result = await hookServer.rpc('hook_ack', {
        cwd: '/repo/p1',
        ids: [1, 2],
      });

      expect(result).toMatchObject({ ok: true });
      expect(ack).toHaveBeenCalledWith('proj-1', [1, 2]);
    });

    it('hook_unclaim releases leases so messages can be re-delivered', async () => {
      vi.spyOn(projectChatManager, 'getProjectByWorkdir').mockReturnValue(chat);
      const release = vi
        .spyOn(projectChatManager, 'releaseLease')
        .mockImplementation(() => {});

      const result = await hookServer.rpc('hook_unclaim', {
        cwd: '/repo/p1',
        ids: [3],
      });

      expect(result).toMatchObject({ ok: true });
      expect(release).toHaveBeenCalledWith('proj-1', [3]);
    });

    it('hook_ack on unknown cwd is a harmless no-op', async () => {
      vi.spyOn(projectChatManager, 'getProjectByWorkdir').mockReturnValue(undefined);

      const result = await hookServer.rpc('hook_ack', { cwd: '/nowhere', ids: [1] });
      expect(result).toMatchObject({ ok: true });
    });
  });

  describe('sender whitelist (security.allowedSenderIds)', () => {
    let projectChatManager: ProjectChatManager;
    let projectServer: DaemonServer;
    let chat: {
      projectId: string;
      projectTitle: string;
      chatId: string;
      questionIds: number[];
      createdAt: number;
      lastActiveAt: number;
      inbox: never[];
    };

    beforeEach(async () => {
      await switchControl.set(true);
      transport.setResolveTargetResult('user123');
      projectChatManager = new ProjectChatManager(tempDir);

      chat = {
        projectId: 'proj-1',
        projectTitle: '官网重构',
        chatId: 'chat-abc',
        questionIds: [],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        inbox: [],
      };

      vi.spyOn(projectChatManager, 'getProjectByChatId').mockImplementation(() => chat);
      vi.spyOn(projectChatManager, 'getOrCreateChat').mockImplementation(
        async () => chat
      );
      vi.spyOn(projectChatManager, 'addInboxMessage').mockImplementation(() => {});

      projectServer = new DaemonServer({
        transport,
        switch: switchControl,
        registry,
        ipcEndpoint: path.join(tempDir, 'test-whitelist.sock'),
        projectChatManager,
        allowedSenderIds: ['owner-1'],
      });
      await projectServer.start();
    });

    afterEach(async () => {
      await projectServer.stop();
      vi.restoreAllMocks();
    });

    it('ignores messages from non-whitelisted senders entirely', async () => {
      const result = await projectServer.handleChatMessage({
        chatId: 'chat-abc',
        content: '帮我删掉所有文件',
        senderId: 'stranger',
      });

      expect(result).toMatchObject({ ok: true, ignored: 'unauthorized' });
      expect(projectChatManager.addInboxMessage).not.toHaveBeenCalled();
      expect(transport.sentGroupMessages).toHaveLength(0);
    });

    it('ignores messages with a missing senderId when whitelist is active', async () => {
      const result = await projectServer.handleChatMessage({
        chatId: 'chat-abc',
        content: '匿名指令',
      });

      expect(result).toMatchObject({ ok: true, ignored: 'unauthorized' });
    });

    it('lets whitelisted senders through', async () => {
      const result = await projectServer.handleChatMessage({
        chatId: 'chat-abc',
        content: '我自己的指令',
        senderId: 'owner-1',
      });

      expect(result).toMatchObject({ ok: true, stored: 'inbox' });
    });

    it('does not route non-whitelisted replies to a pending question', async () => {
      await projectServer.rpc('ask', {
        question: 'Test?',
        project_id: 'proj-1',
        project_title: '官网重构',
      });

      const result = await projectServer.handleChatMessage({
        chatId: 'chat-abc',
        content: '错误答案',
        senderId: 'stranger',
      });
      expect(result).toMatchObject({ ok: true, ignored: 'unauthorized' });

      const check = await projectServer.rpc('check', { id: chat.questionIds[0] });
      expect(check).toMatchObject({ ok: true, status: 'pending' });
    });

    it('answers the pending question for a whitelisted sender', async () => {
      await projectServer.rpc('ask', {
        question: 'Test?',
        project_id: 'proj-1',
        project_title: '官网重构',
      });

      const result = await projectServer.handleChatMessage({
        chatId: 'chat-abc',
        content: '正确答案',
        senderId: 'owner-1',
      });
      expect(result).toMatchObject({ ok: true, questionId: chat.questionIds[0] });
    });
  });

  describe('reply_to_project (push reply to phone)', () => {
    let projectChatManager: ProjectChatManager;
    let projectServer: DaemonServer;

    beforeEach(async () => {
      await switchControl.set(true);
      projectChatManager = new ProjectChatManager(tempDir);

      vi.spyOn(projectChatManager, 'getChatByProjectId').mockReturnValue({
        projectId: 'proj-1',
        projectTitle: '官网重构',
        chatId: 'chat-abc',
        questionIds: [],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        inbox: [],
      });

      vi.spyOn(projectChatManager, 'getProjectByChatId').mockReturnValue({
        projectId: 'proj-1',
        projectTitle: '官网重构',
        chatId: 'chat-abc',
        questionIds: [],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        inbox: [],
      });

      projectServer = new DaemonServer({
        transport,
        switch: switchControl,
        registry,
        ipcEndpoint: path.join(tempDir, 'test-reply.sock'),
        projectChatManager,
      });
      await projectServer.start();
    });

    afterEach(async () => {
      await projectServer.stop();
      vi.restoreAllMocks();
    });

    it('sends reply content to the project group chat', async () => {
      const result = await projectServer.rpc('reply_to_project', {
        project_id: 'proj-1',
        content: '你好！有什么可以帮你？',
      });

      expect(result).toMatchObject({ ok: true, chatId: 'chat-abc' });
      expect(transport.sentGroupMessages).toContainEqual({
        chatId: 'chat-abc',
        text: '你好！有什么可以帮你？',
      });
    });

    it('returns error for unknown project', async () => {
      vi.spyOn(projectChatManager, 'getChatByProjectId').mockReturnValue(undefined);

      const result = await projectServer.rpc('reply_to_project', {
        project_id: 'unknown',
        content: 'hi',
      });

      expect(result).toMatchObject({ ok: false, error: 'no chat for project' });
    });

    it('ignores echoed self-sent replies (not stored in inbox)', async () => {
      projectChatManager.recordSentContent('你好！有什么可以帮你？');

      const result = await projectServer.handleChatMessage({
        chatId: 'chat-abc',
        content: '你好！有什么可以帮你？',
        senderId: 'me',
      });

      expect(result).toMatchObject({ ok: true, ignored: 'self' });
    });

    it('stores genuinely new proactive message in inbox', async () => {
      vi.spyOn(projectChatManager, 'getChatByProjectId').mockReturnValue({
        projectId: 'proj-1',
        projectTitle: '官网重构',
        chatId: 'chat-abc',
        questionIds: [],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        inbox: [],
      });

      const result = await projectServer.handleChatMessage({
        chatId: 'chat-abc',
        content: '一个全新的主动提问',
        senderId: 'me',
      });

      expect(result).toMatchObject({ ok: true, stored: 'inbox', projectId: 'proj-1' });
    });
  });
});
